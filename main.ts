// Graduation sprint: trade only bonding curves that are already most of the way to the
// 85 SOL graduation cap, take the last leg of the run and leave early.
//
// Read the market from the replay's own batches: every TradeEvent carries the post-trade
// reserves, so progress toward graduation is exactly 1 - real_token_reserves / 793.1e12.
// Measured on the dev window: 35 of 1,222 coins graduate, 53% of the coins that ever reach
// 80% progress graduate, 74% of those that reach 90%. The median coin that reaches 50%
// still ends at 0.39x its price there, so holding to the end is a loser: the edge is in the
// minutes right after the sprint starts, not in the graduation itself. So: enter once per
// coin on the first trade that crosses the progress gate with enough real SOL for the 1%
// size cap to allow a real stake, and leave after a fixed number of trades (or on a hard
// stop, or when the curve completes and the replay closes the position for us).

import { BPS, LAMPORTS_PER_SOL, runBot, type BotState, type Curve, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

/** Reserve the curve starts with (CreateEvent real_token_reserves is 793.1e12 for every coin). */
const REAL_TOKEN_RESERVES_0 = 793_100_000_000_000n;

const PARAMS = {
  /** Fraction of the curve already sold, in bps, before a coin is a candidate. */
  minProgressBps: 6_000,
  /** Lamports of stake per coin (also capped by 1% of the mint's real SOL reserve). */
  stakeLamports: LAMPORTS_PER_SOL / 2n,
  /** Smallest stake worth the two transaction fees. */
  minStakeLamports: LAMPORTS_PER_SOL / 100n,
  /** Trades on the coin after entry before the position is sold. */
  exitAfterTrades: 8,
  /** Hard stop: sell when the position is worth this far under its cost (bps). */
  stopBps: 4_000,
  /** Take profit once marked value is this far above cost (bps). */
  takeProfitBps: 3_000,
  /** Stop opening new positions once equity is this far under its peak (bps). */
  maxDrawdownBps: 3_000,
  /** Slippage tolerated on a buy: the price may move this far in the two latency slots. */
  buySlippageBps: 1_500,
  /** Slippage tolerated on a sell. */
  sellSlippageBps: 5_000,
} as const;

interface Coin {
  /** Trades seen on this mint so far. */
  trades: number;
  /** Trades seen since our entry (reset when a position opens). */
  sinceEntry: number;
  /** Best progress seen (bps). */
  bestProgressBps: number;
  /** Never buy this mint again. */
  done: boolean;
  slots: Set<number>;
}

const coins = new Map<Pubkey, Coin>();
let peakEquity = 0n;

function coinOf(mint: Pubkey): Coin {
  const c = coins.get(mint);
  if (c !== undefined) return c;
  const made: Coin = { trades: 0, sinceEntry: 0, bestProgressBps: 0, done: false, slots: new Set<number>() };
  coins.set(mint, made);
  return made;
}

function progressBps(curve: Curve): number {
  if (curve.real_token_reserves >= REAL_TOKEN_RESERVES_0) return 0;
  const sold = REAL_TOKEN_RESERVES_0 - curve.real_token_reserves;
  return Number((sold * BPS) / REAL_TOKEN_RESERVES_0);
}

/** What selling `tokens` against a curve's latest reserves pays, less the 125 bps of curve fees. */
function sellProceeds(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * 125n + BPS - 1n) / BPS;
}

await runBot({
  onHello() {
    coins.clear();
    peakEquity = 0n;
  },

  onBatch(state: BotState, batch) {
    const { caps } = state.hello;
    const tx = state.txFeeLamports();
    const orders: OrderInput[] = [];

    // 1. Fold this batch's events: trade counts and progress per coin.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const c = coinOf(e.mint);
        c.trades = 0;
        c.sinceEntry = 0;
        c.bestProgressBps = 0;
        c.slots.clear();
        continue;
      }
      const c = coinOf(e.mint);
      if (e.event === 'CompleteEvent') {
        c.done = true;
        continue;
      }
      c.trades += 1;
      c.sinceEntry += 1;
      c.slots.add(e.slot);
      const curve = state.curves.get(e.mint);
      if (curve !== undefined) c.bestProgressBps = Math.max(c.bestProgressBps, progressBps(curve));
    }

    // 2. Equity for the drawdown gate: cash plus what every holding would fetch now.
    const mark = new Map<Pubkey, { vq: bigint; vt: bigint }>();
    for (const m of batch.marks) mark.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
    let equity = state.cash;
    for (const [mint, pos] of state.positions) {
      const mk = mark.get(mint);
      if (mk === undefined) continue;
      equity += sellProceeds(pos.token_amount, mk.vq, mk.vt);
    }
    if (equity > peakEquity) peakEquity = equity;
    const drawdownBps = peakEquity === 0n ? 0n : ((peakEquity - equity) * BPS) / peakEquity;

    // 3. Exits first: they free position slots and cash for the same batch.
    const selling = new Set<Pubkey>();
    for (const p of state.pending.values()) if (p.order.side === 'sell') selling.add(p.order.mint);
    for (const [mint, pos] of state.positions) {
      if (orders.length >= caps.max_orders_per_batch) break;
      if (selling.has(mint)) continue;
      const c = coins.get(mint);
      const mk = mark.get(mint);
      const cv = state.curves.get(mint);
      if (mk === undefined && cv === undefined) continue;
      const vq = mk?.vq ?? cv!.virtual_quote_reserves;
      const vt = mk?.vt ?? cv!.virtual_token_reserves;
      const value = sellProceeds(pos.token_amount, vq, vt) - tx;
      const basis = pos.cost_lamports;
      const stale = c !== undefined && c.sinceEntry >= PARAMS.exitAfterTrades;
      const stopped = basis > 0n && value * BPS <= basis * (BPS - BigInt(PARAMS.stopBps));
      const profit = basis > 0n && value * BPS >= basis * (BPS + BigInt(PARAMS.takeProfitBps));
      if (!stale && !stopped && !profit) continue;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: PARAMS.sellSlippageBps });
      selling.add(mint);
      if (c !== undefined) c.done = true;
    }

    // 4. Entries: only while the book is not in a deep drawdown.
    if (drawdownBps <= BigInt(PARAMS.maxDrawdownBps)) {
      let free = state.freeCashLamports();
      let slots = caps.max_open_positions - state.committedPositionCount();
      for (const e of batch.events) {
        if (orders.length >= caps.max_orders_per_batch) break;
        if (e.event !== 'TradeEvent') continue;
        const mint = e.mint;
        const c = coins.get(mint);
        if (c === undefined || c.done) continue;
        if (state.positions.has(mint)) continue;
        let pendingBuy = false;
        for (const p of state.pending.values()) if (p.order.side === 'buy' && p.order.mint === mint) pendingBuy = true;
        if (pendingBuy) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (progressBps(curve) < PARAMS.minProgressBps) continue;
        if (c.slots.size > 1) continue;
        const cap = state.maxBuyLamports(mint);
        const stake = cap < BigInt(PARAMS.stakeLamports) ? cap : BigInt(PARAMS.stakeLamports);
        if (stake < BigInt(PARAMS.minStakeLamports)) continue;
        if (slots <= 0 || free < stake + tx) continue;
        orders.push({ side: 'buy', mint, quote_lamports: stake, max_slippage_bps: PARAMS.buySlippageBps });
        c.sinceEntry = 0;
        free -= stake + tx;
        slots -= 1;
      }
    }

    return orders;
  },
});

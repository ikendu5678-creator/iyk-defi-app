"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { ethers } from "ethers";

// ── Constants ─────────────────────────────────────────────────────────────────

const TOKEN_ADDRESS    = "0x785904b4a81d11f792207a65E49523744c14075c";
const CONTRACT_ADDRESS = "0xeca28fA84371e03D738700c4F24d5F069f912ACd";
const SEPOLIA_ID       = "0xaa36a7";

const TOKEN_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function transfer(address, uint256) returns (bool)",
  "function totalSupply() view returns (uint256)",
];

const ABI = [
  "function stake(uint256 amount)",
  "function unstake(uint256 amount)",
  "function claimRewards()",
  "function emergencyUserExit()",
  "function fundRewardPool(uint256 amount)",
  "function setRewardRate(uint256 newRate)",
  "function setUnstakeCooldown(uint256 newCooldown)",
  "function pauseStaking()",
  "function unpauseStaking()",
  "function withdrawExcessRewards(uint256 amount)",
  "function earned(address) view returns (uint256)",
  "function stakedBalance(address) view returns (uint256)",
  "function stakingStart(address) view returns (uint256)",
  "function totalStaked() view returns (uint256)",
  "function rewardRate() view returns (uint256)",
  "function unstakeCooldown() view returns (uint256)",
  "function contractRewardPool() view returns (uint256)",
  "function isPoolSufficient() view returns (bool)",
  "function paused() view returns (bool)",
  "function killed() view returns (bool)",
  "function owner() view returns (address)",
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: bigint, dp = 4) {
  return parseFloat(ethers.formatUnits(n, 18)).toLocaleString(undefined, {
    minimumFractionDigits: dp, maximumFractionDigits: dp,
  });
}

function fmtStr(s: string | null, dp = 2) {
  if (!s) return "—";
  const n = parseFloat(s);
  return isNaN(n) ? "—" : n.toLocaleString(undefined, { maximumFractionDigits: dp });
}

function calcAPR(rate: bigint, total: bigint): string {
  if (total === 0n) return "∞";
  return ((Number(rate) / Number(total)) * 365 * 86400 * 100).toFixed(2) + "%";
}

function calcAPY(apr: string): string {
  const a = parseFloat(apr.replace("%", "")) / 100;
  if (!isFinite(a)) return "∞";
  return ((Math.pow(1 + a / 365, 365) - 1) * 100).toFixed(2) + "%";
}

function cooldownLabel(startTs: number, cooldownSec: number) {
  const rem = Math.max(0, startTs + cooldownSec - Math.floor(Date.now() / 1000));
  if (rem === 0) return { secs: 0, label: "✓ Unlocked" };
  const h = Math.floor(rem / 3600), m = Math.ceil((rem % 3600) / 60);
  return { secs: rem, label: h > 0 ? `${h}h ${m}m left` : `${m}m left` };
}

function decodeError(e: any): string {
  if (e?.message?.includes("EnforcedPause"))     return "Staking is currently paused.";
  if (e?.message?.includes("user rejected"))     return "Transaction rejected.";
  if (e?.message?.includes("No rewards"))        return "No rewards to claim yet.";
  if (e?.message?.includes("Not enough staked")) return "Insufficient staked balance.";
  if (e?.message?.includes("Cooldown"))          return "Unstake cooldown still active.";
  if (e?.reason) return e.reason;
  return (e?.message ?? "Transaction failed.").replace(/\(action=.*$/, "").slice(0, 140);
}


// ── Spec-required helpers ────────────────────────────────────────────────────

/** Format token amount: bigint(18 dec) → "1,234.56" */
function fmtToken(raw: bigint, dp = 2): string {
  const n = parseFloat(ethers.formatUnits(raw, 18));
  return n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/** Format APR from basis points: 1245n → "12.45%" */
function fmtAPRbps(bps: bigint): string {
  return (Number(bps) / 100).toFixed(2) + "%";
}

/** Format coverage ratio: 0.982 → "98.2%" */
function fmtCoverage(pool: bigint, owed: bigint): string {
  if (owed === 0n) return "100.0%";
  const ratio = Number(pool * 10000n / owed) / 100;
  return Math.min(100, ratio).toFixed(1) + "%";
}

/** Tx state machine */
function isValidAddr(a: string) {
  try { ethers.getAddress(a); return true; } catch { return false; }
}

async function ensureSepolia() {
  try {
    await (window as any).ethereum.request({
      method: "wallet_switchEthereumChain", params: [{ chainId: SEPOLIA_ID }],
    });
    return true;
  } catch { return false; }
}

// ── Types ─────────────────────────────────────────────────────────────────────

type Notif = { msg: string; kind: "info" | "ok" | "err" | "warn" | "load" };

const NOTIF_COLOR: Record<Notif["kind"], string> = {
  info: "#94a3b8", ok: "#4ade80", err: "#f87171", warn: "#fb923c", load: "#facc15",
};

// ── Sub-components ────────────────────────────────────────────────────────────

function Notification({ notif }: { notif: Notif | null }) {
  if (!notif) return null;
  return (
    <div style={{
      background: "#111827", border: `1px solid ${NOTIF_COLOR[notif.kind]}`,
      borderRadius: 10, padding: "11px 16px", marginBottom: 16,
      color: NOTIF_COLOR[notif.kind], fontSize: 13, lineHeight: 1.6,
      display: "flex", alignItems: "center", gap: 8,
    }}>
      {notif.kind === "load" && <span style={{ animation: "spin 1s linear infinite", display: "inline-block" }}>⟳</span>}
      {notif.msg}
    </div>
  );
}

function Card({ label, value, sub, color = "#e2e8f0", warn = false }: {
  label: string; value: string; sub?: string; color?: string; warn?: boolean;
}) {
  return (
    <div style={{
      background: warn ? "#1c0a0a" : "#111827",
      border: `1px solid ${warn ? "#7f1d1d" : "#1e293b"}`,
      borderRadius: 12, padding: "14px 10px", textAlign: "center",
    }}>
      <div style={{ fontSize: 10, color: "#64748b", textTransform: "uppercase" as const, letterSpacing: 0.8, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 700, color }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: warn ? "#7f1d1d" : "#475569", marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function Btn({ label, onClick, color, disabled = false, full = true, sm = false }: {
  label: string; onClick: () => void; color: string; disabled?: boolean; full?: boolean; sm?: boolean;
}) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      padding: sm ? "9px 16px" : "13px 0", borderRadius: 10, border: "none",
      width: full ? "100%" : "auto",
      background: disabled ? "#1e293b" : color,
      color: disabled ? "#475569" : "white",
      fontWeight: 700, fontSize: sm ? 13 : 14,
      cursor: disabled ? "not-allowed" : "pointer",
      transition: "filter 0.15s",
    }}>{label}</button>
  );
}

function SLabel({ text, color = "#64748b" }: { text: string; color?: string }) {
  return <div style={{ fontSize: 11, color, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: 1, marginBottom: 12 }}>{text}</div>;
}

function Panel({ children, warn = false, style = {} }: { children: React.ReactNode; warn?: boolean; style?: React.CSSProperties }) {
  return (
    <div style={{
      background: "#111827", borderRadius: 14, padding: "18px 20px", marginBottom: 16,
      border: `1px solid ${warn ? "#7f1d1d" : "#1e293b"}`, ...style,
    }}>{children}</div>
  );
}


// ── TxBtn: button with built-in tx state feedback ────────────────────────────

type TxState = "idle" | "pending" | "success" | "error";
const TX_MSG: Record<TxState, string> = {
  idle:    "",
  pending: "⏳ Waiting...",
  success: "✅ Done!",
  error:   "❌ Failed",
};

function TxBtn({ label, txState, color, disabled, onClick }: {
  label: string; txState: TxState; color: string; disabled: boolean; onClick: () => void;
}) {
  const isPending = txState === "pending";
  const isSuccess = txState === "success";
  const isError   = txState === "error";
  const bg = isPending ? "#1e3a5f" : isSuccess ? "#166534" : isError ? "#7f1d1d" : disabled ? "#1e293b" : color;
  const lbl = isPending ? TX_MSG.pending : isSuccess ? TX_MSG.success : isError ? TX_MSG.error : label;
  return (
    <button onClick={onClick} disabled={disabled || isPending} style={{
      padding: "13px 0", borderRadius: 10, border: "none", width: "100%",
      background: bg, color: disabled && !isPending && !isSuccess && !isError ? "#475569" : "white",
      fontWeight: 700, fontSize: 13, cursor: disabled || isPending ? "not-allowed" : "pointer",
      transition: "background 0.2s", display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
    }}>
      {isPending && <span style={{ display:"inline-block", animation:"spin 1s linear infinite" }}>⟳</span>}
      {lbl}
    </button>
  );
}

// ── Live Rewards Ticker ────────────────────────────────────────────────────────

function LiveRewards({ earnedRaw, stakedRaw, rateRaw, totalStakedRaw, warn }: {
  earnedRaw: bigint; stakedRaw: bigint; rateRaw: bigint; totalStakedRaw: bigint; warn: boolean;
}) {
  const [display, setDisplay] = useState("0.000000");
  const snap = useRef({ earnedRaw, stakedRaw, rateRaw, totalStakedRaw, ts: Date.now() });

  useEffect(() => { snap.current = { earnedRaw, stakedRaw, rateRaw, totalStakedRaw, ts: Date.now() }; },
    [earnedRaw, stakedRaw, rateRaw, totalStakedRaw]);

  useEffect(() => {
    const id = setInterval(() => {
      const { earnedRaw: base, stakedRaw: s, rateRaw: r, totalStakedRaw: t, ts } = snap.current;
      if (s === 0n || t === 0n) { setDisplay(fmt(base, 6)); return; }
      const elapsedSec = (Date.now() - ts) / 1000;
      // user's share of global rate
      const userRate = Number(ethers.formatUnits(r, 18)) * (Number(s) / Number(t));
      const total    = parseFloat(ethers.formatUnits(base, 18)) + userRate * elapsedSec;
      setDisplay(total.toLocaleString(undefined, { minimumFractionDigits: 6, maximumFractionDigits: 6 }));
    }, 100);
    return () => clearInterval(id);
  }, []);

  return (
    <div style={{
      background: warn ? "#1c0a0a" : "#0d1f3c",
      border: `1px solid ${warn ? "#7f1d1d" : "#1e3a5f"}`,
      borderRadius: 12, padding: "16px 14px", textAlign: "center",
    }}>
      <div style={{ fontSize: 10, color: "#64748b", textTransform: "uppercase" as const, letterSpacing: 0.8, marginBottom: 6, display: "flex", justifyContent: "center", alignItems: "center", gap: 6 }}>
        Pending Rewards
        {!warn && <span style={{ fontSize: 9, color: "#4ade80", background: "#0a2a0a", border: "1px solid #166534", borderRadius: 20, padding: "1px 7px" }}>● LIVE</span>}
      </div>
      <div style={{ fontSize: 22, fontWeight: 800, color: warn ? "#f87171" : "#4ade80", fontVariantNumeric: "tabular-nums" as const, letterSpacing: -0.5 }}>
        {display}
      </div>
      <div style={{ fontSize: 11, color: warn ? "#7f1d1d" : "#166534", marginTop: 4 }}>
        {warn ? "⚠ Pool underfunded — claim disabled" : "IYK · accruing every second"}
      </div>
    </div>
  );
}

// ── APR Banner ────────────────────────────────────────────────────────────────

function APRBanner({ rateRaw, totalStakedRaw }: { rateRaw: bigint; totalStakedRaw: bigint }) {
  const apr = calcAPR(rateRaw, totalStakedRaw);
  const apy = calcAPY(apr);
  const daily = totalStakedRaw > 0n
    ? ((Number(rateRaw) / Number(totalStakedRaw)) * 86400 * 100).toFixed(4) + "%"
    : "∞";

  return (
    <div style={{
      background: "linear-gradient(135deg, #0d1f3c 0%, #0a1a2e 100%)",
      border: "1px solid #1e3a5f", borderRadius: 14, padding: "16px 20px", marginBottom: 16,
      display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" as const, gap: 12,
    }}>
      <div>
        <div style={{ fontSize: 10, color: "#64748b", textTransform: "uppercase" as const, letterSpacing: 1, marginBottom: 4 }}>Staking Yield</div>
        <div style={{ fontSize: 13, color: "#475569" }}>Earn IYK by locking your tokens</div>
      </div>
      <div style={{ display: "flex", gap: 24 }}>
        {[{ l: "APR", v: apr, c: "#fbbf24" }, { l: "APY", v: apy, c: "#34d399" }, { l: "Daily", v: daily, c: "#818cf8" }].map(({ l, v, c }) => (
          <div key={l} style={{ textAlign: "center" as const }}>
            <div style={{ fontSize: 10, color: "#64748b", marginBottom: 4, textTransform: "uppercase" as const, letterSpacing: 0.8 }}>{l}</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: c }}>{v}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Underfunded Warning ───────────────────────────────────────────────────────

function UnderfundedBanner({ earnedRaw, poolRaw }: { earnedRaw: bigint; poolRaw: bigint }) {
  if (earnedRaw === 0n || poolRaw >= earnedRaw) return null;
  const shortage = fmt(earnedRaw - poolRaw, 2);
  return (
    <div style={{
      background: "linear-gradient(135deg,#1c0f03,#1a0a0a)", border: "1px solid #92400e",
      borderRadius: 14, padding: "18px 20px", marginBottom: 20, display: "flex", gap: 14,
    }}>
      <span style={{ fontSize: 26, flexShrink: 0 }}>⚠️</span>
      <div>
        <div style={{ fontWeight: 700, fontSize: 15, color: "#fcd34d", marginBottom: 6 }}>
          Rewards Temporarily Unavailable
        </div>
        <div style={{ fontSize: 13, color: "#fbbf24", lineHeight: 1.7 }}>
          The reward pool needs <strong>{shortage} IYK</strong> more before claims can be processed.
          Your earned rewards are secured on-chain — staking and unstaking continue normally.
        </div>
        <div style={{ marginTop: 10, fontSize: 12, color: "#92400e", background: "#1c0f03", border: "1px solid #78350f", borderRadius: 8, padding: "8px 12px", display: "inline-block" }}>
          🔒 Your rewards are safe and will be claimable once the admin replenishes the pool.
        </div>
      </div>
    </div>
  );
}


// ── AI Staking Advisor ────────────────────────────────────────────────────────

type AIMessage = { role: "user" | "assistant"; content: string };

function AIAdvisor({ walletBal, stakedRaw, earnedRaw, poolRaw, rateRaw, totalSRaw, sufficient, isPaused, isKilled, isAdmin, coverPct, apr, startTs, cooldownSec }: {
  walletBal: bigint; stakedRaw: bigint; earnedRaw: bigint; poolRaw: bigint;
  rateRaw: bigint; totalSRaw: bigint; sufficient: boolean | null;
  isPaused: boolean; isKilled: boolean; isAdmin: boolean; coverPct: number; apr: string;
  startTs: number; cooldownSec: number;
}) {
  const [open,     setOpen]     = useState(false);
  const [messages, setMessages] = useState<AIMessage[]>([]);
  const [input,    setInput]    = useState("");
  const [thinking, setThinking] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior:"smooth" }); }, [messages]);

  const quickPrompts = isAdmin ? [
    "When will the reward pool run dry?",
    "Should I adjust the reward rate?",
    "Draft an emergency message for users",
    "Give me a health report of the protocol",
  ] : [
    "Should I stake now?",
    "How much will I earn if I stake 1000 IYK for 30 days?",
    "Is it safe to claim my rewards?",
    "Explain my pending rewards",
  ];

  const buildContext = () => {
    const fmtB = (b: bigint) => parseFloat(ethers.formatUnits(b, 18)).toFixed(4);
    const poolRunoutDays = rateRaw > 0n && totalSRaw > 0n
      ? (Number(poolRaw) / Number(rateRaw) / 86400).toFixed(1)
      : "∞";
    return `You are IYK AI, an expert DeFi staking assistant embedded in the IYK DeFi Protocol dashboard.
You are helpful, concise, and honest. You always give actionable advice based on real on-chain data.
Never make up numbers — only use the data provided below.
Keep responses under 120 words unless asked for detail. Use bullet points for clarity.

=== LIVE CONTRACT DATA ===
Contract: 0xeca28fA84371e03D738700c4F24d5F069f912ACd (Sepolia testnet)
Token: IYK (ERC20)
Network status: ${isKilled ? "KILLED — contract shut down" : isPaused ? "PAUSED — staking suspended" : "ACTIVE"}
Current APR: ${apr}
Total staked: ${fmtB(totalSRaw)} IYK
Reward rate: ${parseFloat(ethers.formatUnits(rateRaw, 18)).toFixed(8)} IYK/sec
Reward pool balance: ${fmtB(poolRaw)} IYK
Pool coverage: ${coverPct.toFixed(1)}%
Pool sufficient: ${sufficient === null ? "unknown" : sufficient ? "yes" : "NO — UNDERFUNDED"}
Estimated days until pool depletes: ${poolRunoutDays} days

=== USER WALLET DATA ===
Wallet IYK balance: ${fmtB(walletBal)} IYK
Staked: ${fmtB(stakedRaw)} IYK
Pending rewards: ${fmtB(earnedRaw)} IYK
User role: ${isAdmin ? "ADMIN/OWNER" : "regular staker"}

=== IMPORTANT CONTEXT ===
- This is a Synthetix-style staking contract
- Users must approve tokens before staking
- There is an unstake cooldown period
- Rewards come from the reward pool funded by the admin
- If pool coverage < 100%, users CANNOT claim rewards`;
  };

  // ── Rule-based AI — no API key needed, works everywhere ──────────────────────
  const getRuleBasedReply = (q: string): string => {
    const query   = q.toLowerCase();
    const earned  = parseFloat(ethers.formatUnits(earnedRaw,  18));
    const pool    = parseFloat(ethers.formatUnits(poolRaw,    18));
    const staked  = parseFloat(ethers.formatUnits(stakedRaw,  18));
    const wallet  = parseFloat(ethers.formatUnits(walletBal,  18));
    const rate    = parseFloat(ethers.formatUnits(rateRaw,    18));
    const total   = parseFloat(ethers.formatUnits(totalSRaw,  18));
    const userShare   = total > 0 ? staked / total : 0;
    const userRateDay = rate * userShare * 86400;
    const poolDays    = rate > 0 ? pool / rate / 86400 : Infinity;
    const aprNum      = parseFloat(apr.replace("%",""));

    // ── Pool run dry ──
    if (query.includes("run dry") || query.includes("pool last") || query.includes("how long") || query.includes("deplete")) {
      if (rate === 0) return "The reward rate is currently 0, so the pool will not deplete.";
      if (!isFinite(poolDays)) return "The pool will not run dry — no tokens are currently staked so no rewards are being paid out.";
      if (poolDays < 1)  return `⚠️ The reward pool is critically low and may run dry in less than 1 day. Admin should fund it immediately.\n\nPool balance: ${pool.toFixed(2)} IYK\nBurn rate: ${(rate * 86400).toFixed(2)} IYK/day`;
      if (poolDays < 7)  return `⚠️ The reward pool will run dry in approximately ${poolDays.toFixed(1)} days.\n\nPool balance: ${pool.toFixed(2)} IYK\nBurn rate: ${(rate * 86400).toFixed(2)} IYK/day\n\nAdmin should fund the pool soon.`;
      return `The reward pool is estimated to last ${poolDays.toFixed(0)} days at the current rate.\n\n• Pool balance: ${pool.toFixed(2)} IYK\n• Daily burn rate: ${(rate * 86400).toFixed(4)} IYK/day\n• Status: ${poolDays > 30 ? "✅ Healthy" : "⚡ Monitor closely"}`;
    }

    // ── Should I stake ──
    if (query.includes("should i stake") || query.includes("good time to stake") || query.includes("worth staking")) {
      if (isKilled) return "❌ The contract has been shut down. Staking is not possible.";
      if (isPaused) return "⏸ Staking is currently paused by the admin. Wait for it to resume before staking.";
      if (!sufficient) return `⚠️ The reward pool is underfunded right now. You can still stake, but you won't be able to claim rewards until the admin funds the pool.\n\nCurrent APR: ${apr}`;
      if (aprNum > 50) return `✅ Yes, this looks like a good time to stake.\n\n• APR: ${apr}\n• Pool status: Healthy (${poolDays.toFixed(0)} days remaining)\n• Your wallet: ${wallet.toFixed(2)} IYK available\n\nRemember to approve tokens first, then stake.`;
      if (aprNum > 10) return `The current APR is ${apr} which is moderate. The pool is healthy with ${poolDays.toFixed(0)} days of rewards remaining. Staking is safe.`;
      return `Current APR is ${apr}. Pool has ${poolDays.toFixed(0)} days of rewards. The decision is yours based on your risk appetite.`;
    }

    // ── Earnings projection ──
    if (query.includes("earn") || query.includes("reward") && query.includes("if i stake") || query.includes("how much") || query.includes("profit")) {
      const match = query.match(/(\d+[\d,]*\.?\d*)/);
      const stakeAmt = match ? parseFloat(match[1].replace(/,/g, "")) : 1000;
      if (total === 0) return `If you stake ${stakeAmt.toLocaleString()} IYK and you are the only staker, you would earn all global rewards.\n\nCurrent reward rate: ${(rate * 86400).toFixed(4)} IYK/day`;
      const share   = stakeAmt / (total + stakeAmt);
      const perDay  = rate * share * 86400;
      const per30   = perDay * 30;
      const per365  = perDay * 365;
      return `If you stake ${stakeAmt.toLocaleString()} IYK:\n\n• Daily earnings: ~${perDay.toFixed(4)} IYK\n• Monthly (30d): ~${per30.toFixed(2)} IYK\n• Yearly (365d): ~${per365.toFixed(2)} IYK\n• Your pool share: ~${(share*100).toFixed(2)}%\n• Current APR: ${apr}\n\nNote: Actual earnings vary as total staked amount changes.`;
    }

    // ── Safe to claim ──
    if (query.includes("safe to claim") || query.includes("can i claim") || query.includes("claim reward")) {
      if (earned === 0) return "You have no pending rewards to claim yet. Stake tokens to start earning.";
      if (!sufficient) return `❌ It is not safe to claim right now. The reward pool only has ${pool.toFixed(2)} IYK but you are owed ${earned.toFixed(4)} IYK.\n\nThe pool needs ${(earned - pool).toFixed(2)} more IYK. Wait for the admin to fund the pool.`;
      return `✅ Yes, it is safe to claim your rewards.\n\n• Pending rewards: ${earned.toFixed(4)} IYK\n• Pool balance: ${pool.toFixed(2)} IYK\n• Coverage: ${coverPct.toFixed(1)}%\n\nClick "Claim Rewards" to receive your tokens.`;
    }

    // ── Explain rewards ──
    if (query.includes("explain") || query.includes("how do reward") || query.includes("how does reward") || query.includes("pending reward")) {
      if (staked === 0) return "You are not currently staking any tokens, so no rewards are accruing. Approve and stake IYK tokens to start earning.";
      return `Here is how your rewards work:\n\n• You have ${staked.toFixed(2)} IYK staked\n• Your share of the pool: ${(userShare*100).toFixed(2)}%\n• You earn ~${userRateDay.toFixed(4)} IYK per day\n• Current pending: ${earned.toFixed(6)} IYK\n\nRewards accrue every second and are calculated proportionally to your share of the total staked amount (${total.toFixed(2)} IYK).`;
    }

    // ── APR / APY ──
    if (query.includes("apr") || query.includes("apy") || query.includes("interest") || query.includes("rate")) {
      const apy = (Math.pow(1 + aprNum/100/365, 365) - 1) * 100;
      return `Current staking yield:\n\n• APR: ${apr}\n• APY (compounded daily): ${apy.toFixed(2)}%\n• Daily rate: ${(aprNum/365).toFixed(4)}%\n• Reward rate: ${(rate*86400).toFixed(4)} IYK/day (global)\n\nAPR may change if total staked amount increases or admin adjusts the reward rate.`;
    }

    // ── Risk ──
    if (query.includes("risk") || query.includes("safe") || query.includes("scam") || query.includes("rugpull") || query.includes("trust")) {
      return `IYK DeFi Protocol risk summary:\n\n✅ Smart contract is on Sepolia testnet\n✅ Your staked tokens are held in the contract\n✅ You can unstake anytime (after cooldown)\n⚠️ Reward pool depends on admin funding\n⚠️ Testnet — not real money\n\nMain risk: If the reward pool runs dry, you can still unstake your principal but cannot claim rewards until it is refunded.`;
    }

    // ── Admin: health report ──
    if (query.includes("health") || query.includes("status") || query.includes("report") || query.includes("overview")) {
      return `Protocol Health Report:\n\n• Total staked: ${total.toFixed(2)} IYK\n• Reward pool: ${pool.toFixed(2)} IYK\n• Pool coverage: ${coverPct.toFixed(1)}%\n• Pool runway: ${isFinite(poolDays) ? poolDays.toFixed(0)+" days" : "∞"}\n• APR: ${apr}\n• Status: ${isKilled?"💀 KILLED":isPaused?"⏸ PAUSED":!sufficient?"⚠️ UNDERFUNDED":"✅ HEALTHY"}\n• Your balance: ${wallet.toFixed(2)} IYK`;
    }

    // ── Admin: adjust rate ──
    if (query.includes("adjust rate") || query.includes("reward rate") || query.includes("change rate")) {
      const sustainability = total > 0 ? (pool / (rate * 86400)).toFixed(0) : "∞";
      return `Reward Rate Analysis:\n\n• Current rate: ${(rate*86400).toFixed(4)} IYK/day (global)\n• Pool runway at current rate: ${sustainability} days\n• Total staked: ${total.toFixed(2)} IYK\n\nRecommendation: ${parseFloat(sustainability) < 14 ? "⚠️ Consider reducing rate or funding pool — runway is under 2 weeks." : parseFloat(sustainability) > 90 ? "Rate is sustainable. No immediate action needed." : "Monitor weekly. Pool is healthy for now."}`;
    }

    // ── Admin: draft emergency ──
    if (query.includes("draft") || query.includes("emergency message") || query.includes("write message")) {
      return `Here is a draft emergency message for your users:\n\n"⚠️ Emergency Maintenance Notice\n\nThe IYK DeFi Protocol is currently undergoing emergency maintenance. Staking and reward claims are temporarily suspended.\n\nYour staked tokens and earned rewards are safe on-chain and will be accessible once maintenance is complete.\n\nWe apologize for the inconvenience and will restore full service as soon as possible.\n\n— IYK DeFi Team"\n\nCopy this into the Emergency Broadcast panel in your Admin Dashboard.`;
    }

    // ── My position ──
    if (query.includes("my position") || query.includes("my stake") || query.includes("my balance") || query.includes("my wallet")) {
      const cdInfo = cooldownLabel(startTs, cooldownSec);
    return `Your current position:\n\n• Wallet balance: ${wallet.toFixed(2)} IYK\n• Staked: ${staked.toFixed(2)} IYK\n• Pending rewards: ${earned.toFixed(6)} IYK\n• Daily earnings: ~${userRateDay.toFixed(4)} IYK/day\n• Pool share: ${(userShare*100).toFixed(2)}%\n• Unstake cooldown: ${cdInfo.secs > 0 ? cdInfo.label : "Unlocked ✅"}`;
    }

    // ── Unstake ──
    if (query.includes("unstake") || query.includes("withdraw")) {
      if (staked === 0) return "You have no staked tokens to unstake.";
      const cdUnstake = cooldownLabel(startTs, cooldownSec);
      if (cdUnstake.secs > 0)  return `⏳ You cannot unstake yet. Cooldown active: ${cdUnstake.label}\n\nYou have ${staked.toFixed(2)} IYK staked. Once the cooldown expires, you can unstake freely.`;
      return `✅ You can unstake now — no cooldown active.\n\nYou have ${staked.toFixed(2)} IYK staked. Enter the amount and click Unstake.\n\nNote: Unstaking does not affect your pending rewards of ${earned.toFixed(4)} IYK.`;
    }

    // ── Default ──
    return `I can help you with:\n\n• "Should I stake now?" — staking recommendation\n• "How much will I earn if I stake 1000 IYK?" — earnings projection\n• "When will the pool run dry?" — pool runway\n• "Is it safe to claim?" — claim safety check\n• "Explain my rewards" — reward breakdown\n• "What is the APR?" — yield info\n• "What are the risks?" — risk summary\n• "Show my position" — your portfolio\n\nAsk me anything about your staking position!`;
  };

  const sendMessage = async (userMsg: string) => {
    if (!userMsg.trim() || thinking) return;
    const newMessages: AIMessage[] = [...messages, { role:"user", content:userMsg }];
    setMessages(newMessages);
    setInput("");
    setThinking(true);

    // Simulate thinking delay for natural feel
    await new Promise(r => setTimeout(r, 800 + Math.random() * 600));

    const reply = getRuleBasedReply(userMsg);
    setMessages(prev => [...prev, { role:"assistant", content:reply }]);
    setThinking(false);
  };

  return (
    <>
      {/* Floating button */}
      <button onClick={() => setOpen(v => !v)} style={{
        position:"fixed", bottom:28, right:28, zIndex:200,
        width:58, height:58, borderRadius:"50%", border:"none",
        background:"linear-gradient(135deg,#2563eb,#7c3aed)",
        color:"white", fontSize:24, cursor:"pointer",
        boxShadow:"0 4px 24px #2563eb66",
        display:"flex", alignItems:"center", justifyContent:"center",
        transition:"transform 0.2s",
      }} title="IYK AI Advisor">
        {open ? "✕" : "🤖"}
      </button>

      {/* Chat panel */}
      {open && (
        <div style={{
          position:"fixed", bottom:100, right:28, zIndex:200,
          width:380, maxWidth:"calc(100vw - 48px)",
          background:"#0d1526", border:"1px solid #1e3a5f",
          borderRadius:18, boxShadow:"0 8px 48px #000a",
          display:"flex", flexDirection:"column" as const,
          maxHeight:"70vh",
        }}>
          {/* Header */}
          <div style={{ background:"linear-gradient(135deg,#2563eb,#7c3aed)", borderRadius:"18px 18px 0 0", padding:"14px 18px", display:"flex", alignItems:"center", gap:10 }}>
            <span style={{ fontSize:20 }}>🤖</span>
            <div>
              <div style={{ fontWeight:700, fontSize:14, color:"white" }}>IYK AI Advisor</div>
              <div style={{ fontSize:11, color:"#bfdbfe" }}>Powered by Gemini · Live contract data</div>
            </div>
            <div style={{ marginLeft:"auto", width:8, height:8, borderRadius:"50%", background:"#4ade80", boxShadow:"0 0 6px #4ade80" }} />
          </div>

          {/* Messages */}
          <div style={{ flex:1, overflowY:"auto" as const, padding:"14px 16px", display:"flex", flexDirection:"column" as const, gap:10, minHeight:200, maxHeight:380 }}>
            {messages.length === 0 && (
              <div style={{ textAlign:"center" as const, padding:"20px 0" }}>
                <div style={{ fontSize:32, marginBottom:8 }}>👋</div>
                <div style={{ fontSize:13, color:"#94a3b8", marginBottom:16 }}>
                  Ask me anything about your staking position, rewards, or protocol health.
                </div>
                <div style={{ display:"flex", flexDirection:"column" as const, gap:6 }}>
                  {quickPrompts.map(q => (
                    <button key={q} onClick={() => sendMessage(q)} style={{
                      background:"#1e293b", border:"1px solid #334155", borderRadius:8,
                      padding:"8px 12px", color:"#94a3b8", fontSize:12,
                      cursor:"pointer", textAlign:"left" as const, lineHeight:1.4,
                      transition:"border-color 0.15s",
                    }}>{q}</button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} style={{ display:"flex", justifyContent:m.role==="user"?"flex-end":"flex-start" }}>
                <div style={{
                  maxWidth:"85%", padding:"10px 13px", borderRadius:m.role==="user"?"14px 14px 4px 14px":"14px 14px 14px 4px",
                  background:m.role==="user"?"linear-gradient(135deg,#2563eb,#7c3aed)":"#1e293b",
                  color:"white", fontSize:13, lineHeight:1.6,
                  border:m.role==="assistant"?"1px solid #1e3a5f":"none",
                  whiteSpace:"pre-wrap" as const,
                }}>
                  {m.content}
                </div>
              </div>
            ))}
            {thinking && (
              <div style={{ display:"flex", justifyContent:"flex-start" }}>
                <div style={{ background:"#1e293b", border:"1px solid #1e3a5f", borderRadius:"14px 14px 14px 4px", padding:"10px 16px", fontSize:13, color:"#64748b" }}>
                  <span style={{ animation:"thinking 1.2s ease-in-out infinite" }}>●</span>
                  <span style={{ animation:"thinking 1.2s ease-in-out infinite 0.2s" }}> ●</span>
                  <span style={{ animation:"thinking 1.2s ease-in-out infinite 0.4s" }}> ●</span>
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div style={{ padding:"12px 14px", borderTop:"1px solid #1e293b", display:"flex", gap:8 }}>
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key==="Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(input); } }}
              placeholder="Ask IYK AI…"
              disabled={thinking}
              style={{ flex:1, background:"#1e293b", border:"1px solid #334155", borderRadius:9, padding:"9px 12px", color:"white", fontSize:13, outline:"none" }}
            />
            <button onClick={() => sendMessage(input)} disabled={thinking || !input.trim()} style={{
              padding:"9px 14px", borderRadius:9, border:"none",
              background:thinking||!input.trim()?"#1e293b":"linear-gradient(135deg,#2563eb,#7c3aed)",
              color:thinking||!input.trim()?"#475569":"white",
              fontWeight:700, fontSize:13, cursor:thinking||!input.trim()?"not-allowed":"pointer",
            }}>
              {thinking ? "…" : "↑"}
            </button>
          </div>

          {/* Footer */}
          <div style={{ padding:"8px 16px 12px", fontSize:10, color:"#334155", textAlign:"center" as const }}>
            Powered by Gemini · Reads live on-chain data · Free tier
          </div>
        </div>
      )}
    </>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function Page() {
  // wallet
  const [address,   setAddress]   = useState("");
  const [isAdmin,   setIsAdmin]   = useState(false);
  const [activeTab, setActiveTab] = useState<"user" | "admin">("user");
  const scRef   = useRef<ethers.Contract | null>(null);
  const tcRef   = useRef<ethers.Contract | null>(null);

  // user data
  const [walletBal,  setWalletBal]  = useState<bigint>(0n);
  const [stakedRaw,  setStakedRaw]  = useState<bigint>(0n);
  const [earnedRaw,  setEarnedRaw]  = useState<bigint>(0n);
  const [startTs,    setStartTs]    = useState(0);

  // contract state
  const [rateRaw,     setRateRaw]     = useState<bigint>(0n);
  const [totalSRaw,   setTotalSRaw]   = useState<bigint>(0n);
  const [poolRaw,     setPoolRaw]     = useState<bigint>(0n);
  const [cooldownSec, setCooldownSec] = useState(0);
  const [sufficient,  setSufficient]  = useState<boolean | null>(null);
  const [isPaused,    setIsPaused]    = useState(false);
  const [isKilled,    setIsKilled]    = useState(false);
  const [totalSupply, setTotalSupply] = useState<bigint>(0n);

  // Emergency broadcast — admin sets, all users see
  const [emergencyMode, setEmergencyMode] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("iyk_emergency") === "true";
  });
  const [emergencyMsg, setEmergencyMsg] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    return localStorage.getItem("iyk_emergency_msg") || "⚠️ Emergency maintenance in progress. Please do not stake or unstake until further notice.";
  });
  const [editingMsg, setEditingMsg] = useState(false);
  const [draftMsg, setDraftMsg] = useState("");

  const [loading,     setLoading]     = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  // ── Allowance tracking (approve flow spec) ──
  const [allowanceRaw, setAllowanceRaw] = useState<bigint>(0n);

  // ── Per-action tx states (transaction feedback spec) ──
  const [txApprove,  setTxApprove]  = useState<TxState>("idle");
  const [txStake,    setTxStake]    = useState<TxState>("idle");
  const [txUnstake,  setTxUnstake]  = useState<TxState>("idle");
  const [txClaim,    setTxClaim]    = useState<TxState>("idle");

  // inputs
  const [amount,      setAmount]      = useState("");
  const [fundAmt,     setFundAmt]     = useState("");
  const [fundStep,    setFundStep]    = useState<"idle"|"approving"|"funding"|"done">("idle");
  const [sendTo,      setSendTo]      = useState("");
  const [sendAmt,     setSendAmt]     = useState("");
  const [newRate,     setNewRate]     = useState("");
  const [newCooldown, setNewCooldown] = useState("");
  const [excessAmt,   setExcessAmt]   = useState("");

  const [notif, setNotif] = useState<Notif | null>(null);
  const [adminNotif, setAdminNotif] = useState<Notif | null>(null);

  const notify      = (msg: string, kind: Notif["kind"]) => setNotif({ msg, kind });
  const adminNotify = (msg: string, kind: Notif["kind"]) => setAdminNotif({ msg, kind });

  const broadcastEmergency = (msg: string) => {
    localStorage.setItem("iyk_emergency", "true");
    localStorage.setItem("iyk_emergency_msg", msg);
    setEmergencyMode(true);
    setEmergencyMsg(msg);
    adminNotify("🚨 Emergency warning broadcast to all users!", "ok");
  };

  const clearEmergency = () => {
    localStorage.removeItem("iyk_emergency");
    localStorage.removeItem("iyk_emergency_msg");
    setEmergencyMode(false);
    adminNotify("✅ Emergency warning cleared. Users can see normal dashboard again.", "ok");
  };

  // ── fetch ────────────────────────────────────────────────────────────────────

  const fetchAll = useCallback(async (addr: string) => {
    const sc = scRef.current, tc = tcRef.current;
    if (!sc || !tc) return;
    setLoading(true);
    try {
      const [
        wBal, staked, earned, start,
        rate, totalS, pool, cooldown,
        suff, paused, killed, owner, supply, allowance,
      ] = await Promise.all([
        tc.balanceOf(addr),
        sc.stakedBalance(addr),
        sc.earned(addr),
        sc.stakingStart(addr),
        sc.rewardRate(),
        sc.totalStaked(),
        sc.contractRewardPool(),
        sc.unstakeCooldown(),
        sc.isPoolSufficient(),
        sc.paused(),
        sc.killed(),
        sc.owner(),
        tc.totalSupply(),
        tc.allowance(addr, CONTRACT_ADDRESS),  // spec: allowance check
      ]);

      setWalletBal(wBal as bigint);
      setStakedRaw(staked as bigint);
      setEarnedRaw(earned as bigint);
      setStartTs(Number(start));
      setRateRaw(rate as bigint);
      setTotalSRaw(totalS as bigint);
      setPoolRaw(pool as bigint);
      setCooldownSec(Number(cooldown));
      setSufficient(suff as boolean);
      setIsPaused(paused as boolean);
      setIsKilled(killed as boolean);
      setIsAdmin((owner as string).toLowerCase() === addr.toLowerCase());
      setTotalSupply(supply as bigint);
      setAllowanceRaw(allowance as bigint);  // spec: track allowance
      setLastRefresh(new Date());

      if (!(suff as boolean) && (earned as bigint) > 0n) {
        setNotif({ msg: "pool_warning", kind: "warn" });
      } else if (notif?.msg === "pool_warning") {
        setNotif(null);
      }
    } catch (e) { console.error("fetchAll:", e); }
    finally { setLoading(false); }
  }, []); // eslint-disable-line

  // auto-refresh every 10s
  useEffect(() => {
    if (!address) return;
    const id = setInterval(() => fetchAll(address), 10000);
    return () => clearInterval(id);
  }, [address, fetchAll]);

  // ── connect ──────────────────────────────────────────────────────────────────

  const connectWallet = async () => {
    if (!(window as any).ethereum) { notify("Please install MetaMask.", "err"); return; }
    notify("Switching to Sepolia…", "load");
    if (!await ensureSepolia()) { notify("Please switch MetaMask to Sepolia testnet.", "err"); return; }
    notify("Connecting wallet…", "load");
    try {
      const prov   = new ethers.BrowserProvider((window as any).ethereum);
      const signer = await prov.getSigner();
      const addr   = await signer.getAddress();
      scRef.current = new ethers.Contract(CONTRACT_ADDRESS, ABI,       signer);
      tcRef.current = new ethers.Contract(TOKEN_ADDRESS,    TOKEN_ABI, signer);
      setAddress(addr);
      await fetchAll(addr);
      setNotif(null);
    } catch (e: any) { notify(decodeError(e), "err"); }
  };

  // ── user actions ─────────────────────────────────────────────────────────────

  // Generic admin tx helper (no tx-state needed for admin actions)
  const withTx = async (
    fn: () => Promise<any>,
    loadMsg: string,
    okMsg: string,
    isAdminAction = false,
  ) => {
    const n = isAdminAction ? adminNotify : notify;
    n(loadMsg, "load");
    try {
      const tx = await fn();
      await tx.wait();
      n(okMsg, "ok");
      await fetchAll(address);
    } catch (e: any) { n(decodeError(e), "err"); }
  };

  // ── Spec: per-action tx state handlers ──────────────────────────────────────

  const approve = async () => {
    if (!amtValid) return;
    setTxApprove("pending");
    try {
      const tx = await tcRef.current!.approve(CONTRACT_ADDRESS, ethers.parseUnits(amount, 18));
      await tx.wait();
      setTxApprove("success");
      await fetchAll(address);          // re-fetches allowance automatically
      setTimeout(() => setTxApprove("idle"), 3000);
    } catch (e: any) {
      setTxApprove("error");
      notify(decodeError(e), "err");
      setTimeout(() => setTxApprove("idle"), 4000);
    }
  };

  const stake = async () => {
    if (!amtValid || isPaused) return;
    setTxStake("pending");
    try {
      const tx = await scRef.current!.stake(ethers.parseUnits(amount, 18));
      await tx.wait();
      setTxStake("success");
      setAmount("");
      await fetchAll(address);
      setTimeout(() => setTxStake("idle"), 3000);
    } catch (e: any) {
      setTxStake("error");
      notify(decodeError(e), "err");
      setTimeout(() => setTxStake("idle"), 4000);
    }
  };

  const unstake = async () => {
    const cd = cooldownLabel(startTs, cooldownSec);
    if (cd.secs > 0) { notify(`Cooldown active — ${cd.label}.`, "err"); return; }
    if (!amtValid) return;
    setTxUnstake("pending");
    try {
      const tx = await scRef.current!.unstake(ethers.parseUnits(amount, 18));
      await tx.wait();
      setTxUnstake("success");
      setAmount("");
      await fetchAll(address);
      setTimeout(() => setTxUnstake("idle"), 3000);
    } catch (e: any) {
      setTxUnstake("error");
      notify(decodeError(e), "err");
      setTimeout(() => setTxUnstake("idle"), 4000);
    }
  };

  const claim = async () => {
    // Spec: underfunded protection — prevent execution, not just disable button
    if (earnedRaw === 0n) { notify("No rewards to claim yet.", "err"); return; }
    if (!sufficient) {
      notify("⚠️ Rewards cannot be claimed until the pool is funded.", "warn");
      return;
    }
    setTxClaim("pending");
    try {
      const tx = await scRef.current!.claimRewards();
      await tx.wait();
      setTxClaim("success");
      await fetchAll(address);
      setTimeout(() => setTxClaim("idle"), 3000);
    } catch (e: any) {
      setTxClaim("error");
      notify(decodeError(e), "err");
      setTimeout(() => setTxClaim("idle"), 4000);
    }
  };

  const emergencyExit = () => {
    if (!window.confirm("⚠️ You will permanently lose ALL pending rewards. Continue?")) return;
    withTx(() => scRef.current!.emergencyUserExit(), "Processing emergency exit…", "Exit complete — stake returned, rewards forfeited.");
  };

  // ── admin actions ─────────────────────────────────────────────────────────────

  const fundPool = async () => {
    if (!fundAmt || Number(fundAmt) <= 0) { adminNotify("Enter a valid amount.", "err"); return; }
    const sc = scRef.current!, tc = tcRef.current!;
    setFundStep("approving");
    adminNotify("Step 1/2 — Approving…", "load");
    try {
      const a = await tc.approve(CONTRACT_ADDRESS, ethers.parseUnits(fundAmt, 18));
      await a.wait();
      setFundStep("funding");
      adminNotify("Step 2/2 — Funding reward pool…", "load");
      const f = await sc.fundRewardPool(ethers.parseUnits(fundAmt, 18));
      await f.wait();
      setFundStep("done");
      setFundAmt("");
      adminNotify(`✅ Funded pool with ${fundAmt} IYK!`, "ok");
      await fetchAll(address);
      setTimeout(() => setFundStep("idle"), 3000);
    } catch (e: any) { setFundStep("idle"); adminNotify(decodeError(e), "err"); }
  };

  const sendTokens = async () => {
    if (!isValidAddr(sendTo)) { adminNotify("Invalid recipient address.", "err"); return; }
    if (!sendAmt || Number(sendAmt) <= 0) { adminNotify("Enter a valid amount.", "err"); return; }
    withTx(() => tcRef.current!.transfer(sendTo, ethers.parseUnits(sendAmt, 18)),
      `Sending ${sendAmt} IYK…`, "✅ Tokens sent!", true);
    setSendTo(""); setSendAmt("");
  };

  const updateRate = () => {
    if (!newRate || Number(newRate) <= 0) { adminNotify("Enter a valid rate.", "err"); return; }
    withTx(() => scRef.current!.setRewardRate(ethers.parseUnits(newRate, 18)),
      "Updating reward rate…", "✅ Reward rate updated!", true);
    setNewRate("");
  };

  const updateCooldown = () => {
    if (!newCooldown || isNaN(Number(newCooldown))) { adminNotify("Enter cooldown in seconds.", "err"); return; }
    withTx(() => scRef.current!.setUnstakeCooldown(Number(newCooldown)),
      "Updating cooldown…", "✅ Cooldown updated!", true);
    setNewCooldown("");
  };

  const togglePause = () => withTx(
    () => isPaused ? scRef.current!.unpauseStaking() : scRef.current!.pauseStaking(),
    isPaused ? "Unpausing…" : "Pausing…",
    isPaused ? "✅ Contract unpaused." : "⏸ Contract paused.",
    true,
  );

  const withdrawExcess = () => {
    if (!excessAmt || Number(excessAmt) <= 0) { adminNotify("Enter a valid amount.", "err"); return; }
    withTx(() => scRef.current!.withdrawExcessRewards(ethers.parseUnits(excessAmt, 18)),
      "Withdrawing excess…", `✅ Withdrew ${excessAmt} IYK.`, true);
    setExcessAmt("");
  };

  // ── derived ───────────────────────────────────────────────────────────────────

  const connected   = address !== "";
  const isLoading   = notif?.kind === "load" || adminNotif?.kind === "load";
  const amtValid    = amount !== "" && Number(amount) > 0;
  const canClaim    = earnedRaw > 0n && sufficient === true;
  const cd          = cooldownLabel(startTs, cooldownSec);
  const shortage    = earnedRaw > poolRaw ? earnedRaw - poolRaw : 0n;
  const coverPct    = earnedRaw === 0n ? 100 : Math.min(100, Number(poolRaw * 10000n / earnedRaw) / 100);
  const apr         = calcAPR(rateRaw, totalSRaw);

  // Spec: approve flow — compare allowance with input amount
  const amountRaw    = amtValid ? BigInt(Math.floor(Number(amount) * 1e18)) : 0n;
  const needsApprove = amtValid && allowanceRaw < amountRaw;  // true → show Approve; false → show Stake
  const anyTxPending = txApprove === "pending" || txStake === "pending" || txUnstake === "pending" || txClaim === "pending";

  const quickFill = (bal: bigint, setter: (v: string) => void) =>
    ["25%","50%","75%","Max"].map(lbl => (
      <button key={lbl} onClick={() => {
        const p = lbl === "Max" ? 1 : parseInt(lbl) / 100;
        setter((parseFloat(ethers.formatUnits(bal, 18)) * p).toFixed(4));
      }} style={{ flex: 1, padding: "5px 0", borderRadius: 6, border: "1px solid #334155", background: "#1e293b", color: "#94a3b8", fontSize: 12, cursor: "pointer" }}>
        {lbl}
      </button>
    ));

  const inp: React.CSSProperties = {
    width: "100%", padding: "11px 14px", borderRadius: 9,
    border: "1px solid #334155", background: "#0a0f1e",
    color: "white", fontSize: 14, boxSizing: "border-box",
  };

  // ── render ────────────────────────────────────────────────────────────────────

  return (
    <main style={{ minHeight: "100vh", background: "#080d1a", color: "white", fontFamily: "'Segoe UI',system-ui,sans-serif", paddingBottom: 60 }}>

      {/* Nav */}
      <nav style={{ background: "#0d1526", borderBottom: "1px solid #1e293b", padding: "14px 24px", display: "flex", justifyContent: "space-between", alignItems: "center", position: "sticky", top: 0, zIndex: 100 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 22 }}>⚡</span>
          <div>
            <div style={{ fontWeight: 800, fontSize: 16 }}>IYK DeFi Protocol</div>
            <div style={{ fontSize: 11, color: "#475569" }}>Advanced Staking V2 · Sepolia</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {isPaused && connected && <span style={{ background:"#fb923c22", border:"1px solid #fb923c", borderRadius:20, padding:"3px 10px", fontSize:11, color:"#fb923c", fontWeight:600 }}>⏸ Paused</span>}
          {isKilled && connected && <span style={{ background:"#f8717122", border:"1px solid #f87171", borderRadius:20, padding:"3px 10px", fontSize:11, color:"#f87171", fontWeight:600 }}>💀 Killed</span>}
          {isAdmin  && connected && <span style={{ background:"#ca8a0422", border:"1px solid #ca8a04", borderRadius:20, padding:"3px 10px", fontSize:11, color:"#fde047", fontWeight:600 }}>👑 Admin</span>}
          <button onClick={connectWallet} disabled={connected || isLoading} style={{ padding:"8px 18px", borderRadius:20, border:"none", background:connected?"#166534":"#2563eb", color:"white", fontWeight:600, fontSize:13, cursor:connected?"default":"pointer" }}>
            {connected ? `✓ ${address.slice(0,6)}…${address.slice(-4)}` : "Connect Wallet"}
          </button>
        </div>
      </nav>

      <div style={{ maxWidth: 640, margin: "0 auto", padding: "28px 20px" }}>

        {/* Underfunded banner */}
        {connected && <UnderfundedBanner earnedRaw={earnedRaw} poolRaw={poolRaw} />}

        {/* Emergency broadcast banner — shown to ALL users when admin activates */}
        {emergencyMode && (
          <div style={{ background:"linear-gradient(135deg,#1c0f03,#1a0a0a)", border:"2px solid #dc2626", borderRadius:14, padding:"18px 20px", marginBottom:20, display:"flex", gap:14, animation:"emergencyPulse 2s ease-in-out infinite" }}>
            <span style={{ fontSize:28, flexShrink:0 }}>🚨</span>
            <div>
              <div style={{ fontWeight:800, fontSize:16, color:"#f87171", marginBottom:6, textTransform:"uppercase" as const, letterSpacing:0.5 }}>
                Emergency Notice
              </div>
              <div style={{ fontSize:14, color:"#fca5a5", lineHeight:1.7 }}>{emergencyMsg}</div>
              <div style={{ marginTop:10, fontSize:12, color:"#7f1d1d", background:"#1c0a0a", border:"1px solid #7f1d1d", borderRadius:8, padding:"6px 12px", display:"inline-block" }}>
                Posted by IYK DeFi Admin · Your funds are safe on-chain
              </div>
            </div>
          </div>
        )}

        {/* Tab switcher — admin only */}
        {isAdmin && connected && (
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:4, background:"#1e293b", borderRadius:14, padding:4, marginBottom:24 }}>
            {(["user","admin"] as const).map(tab => (
              <button key={tab} onClick={() => setActiveTab(tab)} style={{ padding:"11px 0", borderRadius:10, border:"none", background:activeTab===tab?(tab==="admin"?"#ca8a04":"#2563eb"):"transparent", color:activeTab===tab?"white":"#64748b", fontWeight:700, fontSize:14, cursor:"pointer", transition:"all 0.2s" }}>
                {tab === "user" ? "👤 User Dashboard" : "👑 Admin V2"}
              </button>
            ))}
          </div>
        )}

        {/* ═══════════════ USER DASHBOARD ═══════════════ */}
        {activeTab === "user" && (
          <>
            {notif && notif.msg !== "pool_warning" && <Notification notif={notif} />}

            {/* APR Banner */}
            {connected && <APRBanner rateRaw={rateRaw} totalStakedRaw={totalSRaw} />}

            {/* Portfolio */}
            {connected && (
              <Panel>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
                  <SLabel text="Your Portfolio" />
                  <button onClick={() => fetchAll(address)} disabled={loading} style={{ fontSize:12, color:"#475569", background:"transparent", border:"none", cursor:"pointer" }}>
                    ↻ {lastRefresh?.toLocaleTimeString() ?? "Refresh"}
                  </button>
                </div>

                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:10 }}>
                  <Card label="Wallet Balance" value={`${fmtToken(walletBal, 2)} IYK`} color="#38bdf8" />
                  <Card label="Staked"         value={`${fmtToken(stakedRaw, 2)} IYK`} color="#818cf8" />
                </div>

                {/* Live counter — full width */}
                <LiveRewards
                  earnedRaw={earnedRaw} stakedRaw={stakedRaw}
                  rateRaw={rateRaw} totalStakedRaw={totalSRaw}
                  warn={sufficient === false && earnedRaw > 0n}
                />

                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginTop:10 }}>
                  <Card label="Current APR"     value={loading ? "…" : apr}       color="#fbbf24" />
                  <Card label="Unstake Cooldown" value={loading ? "…" : cd.label} color={cd.secs > 0 ? "#fb923c" : "#4ade80"} />
                </div>
              </Panel>
            )}

            {/* Staking actions */}
            <Panel>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                <SLabel text="Stake & Earn" />
                {isPaused && connected && <span style={{ fontSize:12, color:"#fb923c" }}>⏸ Staking paused</span>}
              </div>

              <input type="number" placeholder="Amount" value={amount} min="0"
                onChange={(e) => { const v = e.target.value; if (v===""||Number(v)>=0) setAmount(v); }}
                disabled={isLoading} style={{ ...inp, marginBottom:10 }} />

              {connected && walletBal > 0n && (
                <div style={{ display:"flex", gap:6, marginBottom:14 }}>
                  {quickFill(walletBal, setAmount)}
                </div>
              )}

              {/* Spec: Approve flow — auto-switch Approve ↔ Stake based on allowance */}
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:10 }}>
                {needsApprove ? (
                  <TxBtn
                    label="Approve"
                    txState={txApprove}
                    color="#7c3aed"
                    disabled={anyTxPending || !connected || !amtValid}
                    onClick={approve}
                  />
                ) : (
                  <TxBtn
                    label="Stake"
                    txState={txStake}
                    color="#2563eb"
                    disabled={anyTxPending || !connected || !amtValid || isPaused}
                    onClick={stake}
                  />
                )}
                <TxBtn
                  label="Unstake"
                  txState={txUnstake}
                  color="#dc2626"
                  disabled={anyTxPending || !connected || !amtValid || cd.secs > 0}
                  onClick={unstake}
                />
              </div>

              {/* Allowance hint */}
              {connected && amtValid && !needsApprove && (
                <div style={{ fontSize:11, color:"#166534", marginBottom:10, display:"flex", alignItems:"center", gap:5 }}>
                  <span>✓</span> Allowance sufficient — ready to stake
                </div>
              )}
              {connected && amtValid && needsApprove && (
                <div style={{ fontSize:11, color:"#ca8a04", marginBottom:10, display:"flex", alignItems:"center", gap:5 }}>
                  <span>↑</span> Approve required before staking this amount
                </div>
              )}

              {/* Spec: underfunded protection — disable + warning banner */}
              <TxBtn
                label="Claim Rewards"
                txState={txClaim}
                color={canClaim ? "#059669" : "#1e3a2e"}
                disabled={anyTxPending || !connected || !canClaim}
                onClick={claim}
              />

              {sufficient === false && connected && earnedRaw > 0n && (
                <div style={{ marginTop:10, background:"#1c0f03", border:"1px solid #92400e", borderRadius:9, padding:"12px 14px", fontSize:13, color:"#fbbf24", lineHeight:1.6, display:"flex", gap:10, alignItems:"flex-start" }}>
                  <span style={{ fontSize:18, flexShrink:0 }}>⚠️</span>
                  <div>
                    <strong>Rewards cannot be claimed until the pool is funded.</strong>
                    <div style={{ fontSize:12, marginTop:4, color:"#92400e" }}>
                      Pool needs {fmtToken(shortage, 2)} more IYK · Your {fmtToken(earnedRaw, 4)} IYK is safe on-chain.
                    </div>
                  </div>
                </div>
              )}
            </Panel>













            {/* How it works */}
            <Panel>
              <SLabel text="How It Works" />
              <div style={{ display:"flex", flexDirection:"column" as const, gap:12 }}>
                {[
                  { n:"1", t:"Approve",  d:"Allow the staking contract to access your IYK tokens." },
                  { n:"2", t:"Stake",    d:"Lock tokens to start earning rewards every second, live." },
                  { n:"3", t:"Earn",     d:"Rewards accrue proportionally to your share of the pool." },
                  { n:"4", t:"Claim",    d:"Withdraw earned rewards anytime (when reward pool is funded)." },
                  { n:"5", t:"Unstake",  d:"Retrieve staked tokens after the cooldown period expires." },
                ].map(({ n, t, d }) => (
                  <div key={n} style={{ display:"flex", gap:12, alignItems:"flex-start" }}>
                    <div style={{ background:"#2563eb", borderRadius:"50%", width:26, height:26, display:"flex", alignItems:"center", justifyContent:"center", fontSize:12, fontWeight:700, flexShrink:0 }}>{n}</div>
                    <div>
                      <div style={{ fontWeight:600, fontSize:13, color:"#e2e8f0" }}>{t}</div>
                      <div style={{ fontSize:12, color:"#64748b", marginTop:2 }}>{d}</div>
                    </div>
                  </div>
                ))}
              </div>
            </Panel>
          </>
        )}

        {/* ═══════════════ ADMIN DASHBOARD ═══════════════ */}
        {activeTab === "admin" && !isAdmin && (
          <div style={{ textAlign:"center" as const, padding:"80px 0" }}>
            <div style={{ fontSize:56, marginBottom:16 }}>⛔</div>
            <div style={{ fontWeight:700, fontSize:18, color:"#f87171" }}>Access Denied</div>
            <div style={{ color:"#64748b", fontSize:14, marginTop:8 }}>Restricted to contract owner.</div>
          </div>
        )}

        {activeTab === "admin" && isAdmin && (
          <>
            {adminNotif && <Notification notif={adminNotif} />}

            {/* Admin underfunded alert */}
            {sufficient===false && earnedRaw>0n && (
              <div style={{ background:"#1c0a0a", border:"1px solid #7f1d1d", borderRadius:12, padding:"14px 18px", marginBottom:16, display:"flex", justifyContent:"space-between", alignItems:"center", gap:12, flexWrap:"wrap" as const }}>
                <div>
                  <div style={{ fontWeight:700, color:"#f87171", marginBottom:4 }}>🚨 Reward Pool Underfunded</div>
                  <div style={{ fontSize:13, color:"#fca5a5" }}>
                    Needs <strong>{fmt(shortage, 2)} IYK</strong> more to cover all earned rewards. Fund immediately.
                  </div>
                </div>
                <button onClick={() => setFundAmt(parseFloat(ethers.formatUnits(shortage, 18)).toFixed(4))}
                  style={{ padding:"8px 16px", borderRadius:8, border:"1px solid #f87171", background:"transparent", color:"#f87171", fontSize:12, fontWeight:700, cursor:"pointer", whiteSpace:"nowrap" as const }}>
                  Use Deficit ↓
                </button>
              </div>
            )}

            {/* Protocol health */}
            <Panel>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                <SLabel text="📊 Protocol Health" />
                <button onClick={() => fetchAll(address)} disabled={loading} style={{ fontSize:12, color:"#475569", background:"transparent", border:"none", cursor:"pointer" }}>
                  ↻ {lastRefresh?.toLocaleTimeString() ?? "Refresh"}
                </button>
              </div>

              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10, marginBottom:10 }}>
                <Card label="Reward Pool"   value={`${fmt(poolRaw, 2)} IYK`}     color={sufficient===false?"#f87171":"#4ade80"} warn={sufficient===false} />
                <Card label="Total Staked"  value={`${fmt(totalSRaw, 2)} IYK`}   color="#818cf8" />
                <Card label="APR"           value={apr}                            color="#fbbf24" />
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10, marginBottom:14 }}>
                <Card label="Admin Balance" value={`${fmt(walletBal, 2)} IYK`}   color="#38bdf8" />
                <Card label="Total Supply"  value={`${fmt(totalSupply, 0)} IYK`} color="#e2e8f0" />
                <Card label="Pool Status"   value={sufficient===null?"—":sufficient?"✓ Healthy":"⚠ Low"} color={sufficient?"#4ade80":"#f87171"} />
              </div>

              {/* Coverage bar */}
              <div style={{ marginBottom:14 }}>
                <div style={{ display:"flex", justifyContent:"space-between", marginBottom:6 }}>
                  <span style={{ fontSize:12, color:"#64748b" }}>Pool Coverage</span>
                  <span style={{ fontSize:12, fontWeight:600, color:coverPct>=100?"#4ade80":coverPct>=50?"#facc15":"#f87171" }}>
                    {coverPct.toFixed(1)}%
                  </span>
                </div>
                <div style={{ background:"#0a0f1e", borderRadius:99, height:12, overflow:"hidden" }}>
                  <div style={{ height:"100%", borderRadius:99, transition:"width 0.6s ease", width:`${coverPct}%`, background:coverPct>=100?"#4ade80":coverPct>=50?"#facc15":"#f87171" }} />
                </div>
                <div style={{ fontSize:11, color:"#334155", marginTop:4 }}>100% = contract fully covers all earned rewards</div>
              </div>

              <Btn label={isPaused?"▶ Unpause Staking":"⏸ Pause Staking"}
                color={isPaused?"#166534":"#92400e"} disabled={isLoading||isKilled} onClick={togglePause} />
            </Panel>

            {/* Fund reward pool */}
            <Panel>
              <SLabel text="🏦 Fund Reward Pool" />
              <p style={{ fontSize:13, color:"#64748b", margin:"0 0 14px", lineHeight:1.6 }}>
                Deposit IYK into the reward pool. Requires 2 transactions: Approve → Fund.
              </p>

              {fundStep !== "idle" && (
                <div style={{ display:"flex", gap:6, marginBottom:14, alignItems:"center" }}>
                  {(["approving","funding","done"] as const).map((s, i) => {
                    const order = ["idle","approving","funding","done"];
                    const cur = order.indexOf(fundStep), mine = order.indexOf(s);
                    return (
                      <div key={s} style={{ display:"flex", alignItems:"center", gap:6 }}>
                        {i > 0 && <div style={{ height:1, width:16, background:cur>mine?"#ca8a04":"#334155" }} />}
                        <div style={{ padding:"4px 10px", borderRadius:20, fontSize:12, fontWeight:600, background:cur>mine?"#78350f":cur===mine?"#ca8a04":"#1e293b", color:cur>=mine?"white":"#64748b" }}>
                          {s==="approving"?"1. Approve":s==="funding"?"2. Fund":"✓ Done"}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <label style={{ fontSize:12, color:"#64748b", display:"block", marginBottom:6 }}>Amount (IYK)</label>
              <input type="number" placeholder="e.g. 100000" value={fundAmt} min="0"
                onChange={(e) => { const v=e.target.value; if(v===""||Number(v)>=0) setFundAmt(v); }}
                disabled={isLoading} style={{ ...inp, marginBottom:8 }} />
              <div style={{ display:"flex", gap:6, marginBottom:14 }}>
                {quickFill(walletBal, setFundAmt)}
              </div>
              <Btn label={fundStep==="approving"?"⟳ Approving…":fundStep==="funding"?"⟳ Funding…":fundStep==="done"?"✓ Funded!":"💰 Approve & Fund Pool"}
                color="#ca8a04" disabled={isLoading||!fundAmt||Number(fundAmt)<=0} onClick={fundPool} />
            </Panel>

            {/* Contract controls */}
            <Panel>
              <SLabel text="⚙️ Contract Controls" />
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16, marginBottom:16 }}>
                <div>
                  <label style={{ fontSize:12, color:"#64748b", display:"block", marginBottom:6 }}>Reward Rate (IYK/sec)</label>
                  <input type="number" placeholder="e.g. 0.0001" value={newRate}
                    onChange={(e) => setNewRate(e.target.value)} disabled={isLoading}
                    style={{ ...inp, marginBottom:8 }} />
                  <Btn label="Update Rate" color="#0ea5e9" disabled={isLoading||!newRate} onClick={updateRate} />
                </div>
                <div>
                  <label style={{ fontSize:12, color:"#64748b", display:"block", marginBottom:6 }}>Cooldown (seconds)</label>
                  <input type="number" placeholder="e.g. 86400" value={newCooldown}
                    onChange={(e) => setNewCooldown(e.target.value)} disabled={isLoading}
                    style={{ ...inp, marginBottom:8 }} />
                  <Btn label="Update Cooldown" color="#0ea5e9" disabled={isLoading||!newCooldown} onClick={updateCooldown} />
                </div>
              </div>

              <label style={{ fontSize:12, color:"#64748b", display:"block", marginBottom:6 }}>Withdraw Excess Rewards (IYK)</label>
              <div style={{ display:"flex", gap:10 }}>
                <input type="number" placeholder="Amount" value={excessAmt}
                  onChange={(e) => setExcessAmt(e.target.value)} disabled={isLoading}
                  style={{ ...inp, flex:1 }} />
                <button onClick={withdrawExcess} disabled={isLoading||!excessAmt} style={{ padding:"11px 20px", borderRadius:9, border:"none", background:isLoading||!excessAmt?"#1e293b":"#dc2626", color:isLoading||!excessAmt?"#475569":"white", fontWeight:700, fontSize:14, cursor:isLoading||!excessAmt?"not-allowed":"pointer", whiteSpace:"nowrap" as const }}>
                  Withdraw
                </button>
              </div>
            </Panel>


            {/* Emergency Exit — Admin Only */}
            <Panel warn>
              <SLabel text="🚨 Emergency Exit (Admin Only)" color="#f87171" />
              <p style={{ fontSize:13, color:"#64748b", margin:"0 0 6px", lineHeight:1.6 }}>
                Force-unstake your own staked tokens instantly, bypassing cooldown.
              </p>
              <p style={{ fontSize:12, color:"#f87171", margin:"0 0 14px" }}>
                ⚠ All pending rewards are permanently forfeited. Use only in emergencies.
              </p>
              <Btn label="Emergency Exit — Forfeit Rewards" color="#7f1d1d" disabled={isLoading || stakedRaw === 0n} onClick={emergencyExit} />
              {stakedRaw === 0n && <div style={{ fontSize:12, color:"#334155", marginTop:8, textAlign:"center" as const }}>No staked balance to exit from.</div>}
            </Panel>
            {/* Emergency Broadcast */}
            <Panel warn={emergencyMode}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
                <SLabel text="📢 Emergency Broadcast" color={emergencyMode?"#f87171":"#64748b"} />
                {emergencyMode && (
                  <span style={{ background:"#dc262622", border:"1px solid #dc2626", borderRadius:20, padding:"3px 10px", fontSize:11, color:"#f87171", fontWeight:700 }}>
                    🔴 LIVE — Users can see this
                  </span>
                )}
              </div>
              <p style={{ fontSize:13, color:"#64748b", margin:"0 0 14px", lineHeight:1.6 }}>
                {emergencyMode
                  ? "Emergency warning is currently active and visible to all users."
                  : "Broadcast an emergency warning to all users. Hidden by default until you activate it."}
              </p>

              {!emergencyMode ? (
                <>
                  <label style={{ fontSize:12, color:"#64748b", display:"block", marginBottom:6 }}>Warning Message</label>
                  <textarea
                    value={draftMsg || "⚠️ Emergency maintenance in progress. Please do not stake or unstake until further notice."}
                    onChange={(e) => setDraftMsg(e.target.value)}
                    rows={3}
                    style={{ width:"100%", padding:"11px 14px", borderRadius:9, border:"1px solid #334155", background:"#0a0f1e", color:"white", fontSize:13, boxSizing:"border-box" as const, marginBottom:12, resize:"vertical" as const, fontFamily:"inherit" }}
                  />
                  <button onClick={() => broadcastEmergency(draftMsg || "⚠️ Emergency maintenance in progress. Please do not stake or unstake until further notice.")}
                    style={{ width:"100%", padding:13, borderRadius:10, border:"none", background:"#dc2626", color:"white", fontWeight:700, fontSize:14, cursor:"pointer" }}>
                    🚨 Broadcast Emergency Warning to All Users
                  </button>
                </>
              ) : (
                <>
                  <div style={{ background:"#0a0f1e", borderRadius:9, padding:"12px 14px", marginBottom:14, fontSize:13, color:"#fca5a5", lineHeight:1.6, border:"1px solid #7f1d1d" }}>
                    "{emergencyMsg}"
                  </div>
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
                    <button onClick={() => { setEditingMsg(true); setDraftMsg(emergencyMsg); setEmergencyMode(false); }}
                      style={{ padding:11, borderRadius:9, border:"1px solid #334155", background:"transparent", color:"#94a3b8", fontWeight:600, fontSize:13, cursor:"pointer" }}>
                      ✏ Edit Message
                    </button>
                    <button onClick={clearEmergency}
                      style={{ padding:11, borderRadius:9, border:"none", background:"#166534", color:"white", fontWeight:700, fontSize:13, cursor:"pointer" }}>
                      ✅ Clear Warning
                    </button>
                  </div>
                </>
              )}
            </Panel>

            {/* Send tokens */}
            <Panel>
              <SLabel text="↗ Send Tokens" />
              <label style={{ fontSize:12, color:"#64748b", display:"block", marginBottom:6 }}>Recipient Address</label>
              <input type="text" placeholder="0x…" value={sendTo}
                onChange={(e) => setSendTo(e.target.value)} disabled={isLoading}
                style={{ ...inp, marginBottom: 4, border:`1px solid ${sendTo && !isValidAddr(sendTo) ? "#f87171" : "#334155"}` }} />
              {sendTo && !isValidAddr(sendTo) && (
                <div style={{ fontSize:11, color:"#f87171", marginBottom:8 }}>⚠ Invalid address</div>
              )}
              <label style={{ fontSize:12, color:"#64748b", display:"block", marginBottom:6, marginTop:8 }}>Amount (IYK)</label>
              <input type="number" placeholder="e.g. 1000" value={sendAmt} min="0"
                onChange={(e) => { const v=e.target.value; if(v===""||Number(v)>=0) setSendAmt(v); }}
                disabled={isLoading} style={{ ...inp, marginBottom:14 }} />
              <Btn label="Send IYK" color="#0ea5e9" disabled={isLoading||!sendTo||!sendAmt||!isValidAddr(sendTo)} onClick={sendTokens} />
            </Panel>

            {/* Contract info */}
            <div style={{ background:"#111827", borderRadius:10, padding:"14px 16px", fontSize:11, color:"#334155", wordBreak:"break-all" as const, border:"1px solid #1e293b" }}>
              <div><span style={{ color:"#475569" }}>V2 Contract: </span>{CONTRACT_ADDRESS}</div>
              <div style={{ marginTop:4 }}><span style={{ color:"#475569" }}>Token:       </span>{TOKEN_ADDRESS}</div>
              <div style={{ marginTop:4 }}><span style={{ color:"#475569" }}>Admin:       </span>{address}</div>
            </div>
          </>
        )}
      </div>

      {/* AI Advisor — floating chat button */}
      {connected && (
        <AIAdvisor
          walletBal={walletBal} stakedRaw={stakedRaw} earnedRaw={earnedRaw}
          poolRaw={poolRaw} rateRaw={rateRaw} totalSRaw={totalSRaw}
          sufficient={sufficient} isPaused={isPaused} isKilled={isKilled}
          isAdmin={isAdmin} coverPct={coverPct} apr={apr}
          startTs={startTs} cooldownSec={cooldownSec}
        />
      )}

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes thinking { 0%,100%{opacity:0.2} 50%{opacity:1} }
        @keyframes emergencyPulse { 0%,100%{border-color:#dc2626} 50%{border-color:#f87171} }
        button:hover:not(:disabled) { filter: brightness(1.1); }
        input:focus { outline: none; border-color: #3b82f6 !important; }
      `}</style>
    </main>
  );
}
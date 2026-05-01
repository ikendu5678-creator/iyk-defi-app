"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { ethers } from "ethers";

// ── Constants ─────────────────────────────────────────────────────────────────

const TOKEN_ADDRESS    = "0x785904b4a81d11f792207a65E49523744c14075c";
const CONTRACT_ADDRESS = "0xeca28fA84371e03D738700c4F24d5F069f912ACd";
const SEPOLIA_ID       = "0xaa36a7";

const TOKEN_ABI = [
  "function balanceOf(address) view returns (uint256)",
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

  const [loading,     setLoading]     = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

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

  // ── fetch ────────────────────────────────────────────────────────────────────

  const fetchAll = useCallback(async (addr: string) => {
    const sc = scRef.current, tc = tcRef.current;
    if (!sc || !tc) return;
    setLoading(true);
    try {
      const [
        wBal, staked, earned, start,
        rate, totalS, pool, cooldown,
        suff, paused, killed, owner, supply,
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

  const withTx = async (
    fn: () => Promise<any>,
    loadMsg: string,
    okMsg: string,
    isAdmin = false,
  ) => {
    const n = isAdmin ? adminNotify : notify;
    n(loadMsg, "load");
    try {
      const tx = await fn();
      await tx.wait();
      n(okMsg, "ok");
      await fetchAll(address);
    } catch (e: any) { n(decodeError(e), "err"); }
  };

  const stake = () => withTx(
    () => scRef.current!.stake(ethers.parseUnits(amount, 18)),
    "Staking tokens…", "Staked! Rewards are accruing live. 🎉",
  );

  const unstake = () => {
    const cd = cooldownLabel(startTs, cooldownSec);
    if (cd.secs > 0) { notify(`Cooldown active — ${cd.label}.`, "err"); return; }
    withTx(
      () => scRef.current!.unstake(ethers.parseUnits(amount, 18)),
      "Unstaking…", "Unstake successful!",
    );
  };

  const approve = () => withTx(
    () => tcRef.current!.approve(CONTRACT_ADDRESS, ethers.parseUnits(amount, 18)),
    "Approving tokens…", "Approved! Now click Stake.",
  );

  const claim = () => {
    if (earnedRaw === 0n) { notify("No rewards to claim yet.", "err"); return; }
    if (!sufficient)      { notify("pool_warning", "warn"); return; }
    withTx(() => scRef.current!.claimRewards(), "Claiming rewards…", `Claimed ${fmt(earnedRaw, 4)} IYK! 🎉`);
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
                  <Card label="Wallet Balance" value={`${fmt(walletBal, 2)} IYK`} color="#38bdf8" />
                  <Card label="Staked"         value={`${fmt(stakedRaw, 2)} IYK`} color="#818cf8" />
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

              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:10 }}>
                <Btn label="Approve" color="#7c3aed" disabled={isLoading||!connected||!amtValid} onClick={approve} />
                <Btn label="Stake"   color="#2563eb" disabled={isLoading||!connected||!amtValid||isPaused} onClick={stake} />
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
                <Btn label="Claim Rewards" color={canClaim?"#059669":"#1e3a2e"} disabled={isLoading||!connected||!canClaim} onClick={claim} />
                <Btn label="Unstake"       color="#dc2626" disabled={isLoading||!connected||!amtValid||cd.secs>0} onClick={unstake} />
              </div>

              {sufficient===false && connected && earnedRaw>0n && (
                <div style={{ marginTop:12, background:"#1c0f03", border:"1px solid #78350f", borderRadius:9, padding:"10px 14px", fontSize:12, color:"#fbbf24", lineHeight:1.6 }}>
                  ⚠️ <strong>Claim disabled.</strong> Reward pool needs {fmt(shortage, 2)} more IYK. Your {fmt(earnedRaw, 4)} IYK is safe on-chain.
                </div>
              )}
            </Panel>

            {/* Emergency exit */}
            {connected && stakedRaw > 0n && (
              <Panel warn>
                <SLabel text="⚠ Emergency Exit" color="#f87171" />
                <p style={{ fontSize:13, color:"#64748b", margin:"0 0 14px", lineHeight:1.6 }}>
                  Instantly unstake everything, bypassing cooldown.{" "}
                  <strong style={{ color:"#f87171" }}>All pending rewards are permanently forfeited.</strong>
                </p>
                <Btn label="Emergency Exit — Forfeit Rewards" color="#7f1d1d" disabled={isLoading} onClick={emergencyExit} />
              </Panel>
            )}

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

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        button:hover:not(:disabled) { filter: brightness(1.1); }
        input:focus { outline: none; border-color: #3b82f6 !important; }
      `}</style>
    </main>
  );
}
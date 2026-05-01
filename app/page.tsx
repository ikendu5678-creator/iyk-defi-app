"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { ethers } from "ethers";

const TOKEN_ADDRESS    = "0x785904b4a81d11f792207a65E49523744c14075c";
const STAKING_ADDRESS  = "0xeca28fA84371e03D738700c4F24d5F069f912ACd";
const SEPOLIA_CHAIN_ID = "0xaa36a7";
const ADMIN_ADDRESS    = "0xC31360FD78103EEdd39CAc30AA34Eb83d8d1c825";

const TOKEN_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function totalSupply() view returns (uint256)",
];

const STAKING_ABI = [
  "function stake(uint256 amount)",
  "function unstake(uint256 amount)",
  "function claimRewards()",
  "function emergencyUserExit()",
  "function fundRewardPool(uint256 amount)",
  "function setRewardRate(uint256 newRate)",
  "function setMinStakeAmount(uint256 newMin)",
  "function setUnstakeCooldown(uint256 newCooldown)",
  "function pauseStaking()",
  "function unpauseStaking()",
  "function withdrawExcessRewards(uint256 amount)",
  "function killContract()",
  "function transferOwnership(address newOwner)",
  "function earned(address user) view returns (uint256)",
  "function stakedBalance(address) view returns (uint256)",
  "function pendingRewards(address) view returns (uint256)",
  "function stakingStart(address) view returns (uint256)",
  "function isPoolSufficient() view returns (bool)",
  "function contractRewardPool() view returns (uint256)",
  "function totalStaked() view returns (uint256)",
  "function rewardRate() view returns (uint256)",
  "function minStakeAmount() view returns (uint256)",
  "function unstakeCooldown() view returns (uint256)",
  "function paused() view returns (bool)",
  "function killed() view returns (bool)",
  "function owner() view returns (address)",
  "event Staked(address indexed user, uint256 amount)",
  "event Unstaked(address indexed user, uint256 amount)",
  "event RewardClaimed(address indexed user, uint256 reward)",
  "event RewardPoolFunded(address indexed admin, uint256 amount)",
  "event RewardRateUpdated(uint256 oldRate, uint256 newRate)",
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function validateAmount(a: string) {
  if (!a || a.trim() === "") throw new Error("Please enter an amount.");
  if (isNaN(Number(a)) || Number(a) <= 0) throw new Error("Amount must be a positive number.");
}

function decodeError(e: any): string {
  if (e?.message?.includes("Please enter") || e?.message?.includes("Amount must")) return e.message;
  if (e?.message?.includes("EnforcedPause"))       return "Staking is currently paused by the admin.";
  if (e?.message?.includes("OwnableUnauthorized")) return "Only the contract owner can do this.";
  if (e?.message?.includes("SafeERC20Failed"))     return "Token transfer failed — check balance and approval.";
  if (e?.message?.includes("No rewards"))          return "No rewards to claim yet.";
  if (e?.message?.includes("Not enough staked"))   return "Insufficient staked balance.";
  if (e?.message?.includes("Cooldown"))            return "Unstake cooldown is still active.";
  if (e?.reason) return e.reason;
  return (e?.message ?? "Transaction failed.").replace(/\(action=.*$/, "").trim().slice(0, 160);
}

async function getPS() {
  if (!(window as any).ethereum) throw new Error("MetaMask not found.");
  const provider = new ethers.BrowserProvider((window as any).ethereum);
  return { provider, signer: await provider.getSigner() };
}

async function ensureSepolia() {
  try {
    await (window as any).ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: SEPOLIA_CHAIN_ID }] });
    return true;
  } catch { return false; }
}

function fmt(v: string | null, dp = 2) {
  if (v === null) return "—";
  const n = parseFloat(v);
  return isNaN(n) ? "—" : n.toLocaleString(undefined, { maximumFractionDigits: dp });
}

function fmtBig(raw: bigint, dp = 6) {
  return parseFloat(ethers.formatUnits(raw, 18)).toLocaleString(undefined, { maximumFractionDigits: dp });
}

/** APR in % from raw bigints */
function calcAPR(rateRaw: bigint, totalRaw: bigint): string {
  if (totalRaw === 0n) return "∞";
  const apr = (Number(rateRaw) / Number(totalRaw)) * 365 * 24 * 3600 * 100;
  return apr.toFixed(2) + "%";
}

/** APY from APR % string */
function calcAPY(aprStr: string): string {
  const apr = parseFloat(aprStr.replace("%", "")) / 100;
  if (isNaN(apr) || !isFinite(apr)) return "∞";
  const apy = (Math.pow(1 + apr / 365, 365) - 1) * 100;
  return apy.toFixed(2) + "%";
}

function cooldownInfo(startTs: number, cooldownSec: number) {
  const now = Math.floor(Date.now() / 1000);
  const remaining = Math.max(0, startTs + cooldownSec - now);
  if (remaining === 0) return { secs: 0, label: "✓ Unlocked" };
  const h = Math.floor(remaining / 3600), m = Math.ceil((remaining % 3600) / 60);
  return { secs: remaining, label: h > 0 ? `${h}h ${m}m left` : `${m}m left` };
}

function poolCoverage(pool: bigint, owed: bigint) {
  if (owed === 0n) return 100;
  return Math.min(100, Number(pool * 10000n / owed) / 100);
}

function isInvalidAddr(addr: string): boolean {
  try { ethers.getAddress(addr); return false; } catch { return true; }
}

type ST = "idle" | "loading" | "success" | "error" | "warning";
const SC: Record<ST, string> = { idle:"#94a3b8", loading:"#facc15", success:"#4ade80", error:"#f87171", warning:"#fb923c" };

// ── UI Atoms ──────────────────────────────────────────────────────────────────

function Btn({ label, color, disabled, onClick }: { label:string; color:string; disabled:boolean; onClick:()=>void }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      padding:"13px 0", borderRadius:10, border:"none", width:"100%",
      background:disabled?"#1e293b":color, color:disabled?"#475569":"white",
      fontWeight:700, fontSize:14, cursor:disabled?"not-allowed":"pointer", transition:"filter 0.15s",
    }}>{label}</button>
  );
}

function StatCard({ label, value, sub, color="#e2e8f0", loading=false, warn=false, pulse=false }:
  { label:string; value:string; sub?:string; color?:string; loading?:boolean; warn?:boolean; pulse?:boolean }) {
  return (
    <div style={{ background:warn?"#1c0a0a":"#111827", border:`1px solid ${warn?"#7f1d1d":"#1e293b"}`, borderRadius:12, padding:"14px 10px", textAlign:"center" }}>
      <div style={{ fontSize:11, color:"#64748b", marginBottom:5, textTransform:"uppercase" as const, letterSpacing:0.5 }}>{label}</div>
      <div style={{ fontSize:14, fontWeight:700, color:loading?"#334155":color, animation:pulse?"tick 1s steps(1) infinite":"none" }}>
        {loading?"…":value}
      </div>
      {sub && <div style={{ fontSize:11, color:"#475569", marginTop:4 }}>{sub}</div>}
    </div>
  );
}

function Badge({ label, color }: { label:string; color:string }) {
  return <span style={{ background:`${color}22`, border:`1px solid ${color}`, borderRadius:20, padding:"3px 10px", fontSize:11, color, fontWeight:600 }}>{label}</span>;
}

function Panel({ children, warn=false }: { children:React.ReactNode; warn?:boolean }) {
  return <div style={{ background:"#111827", borderRadius:14, padding:"18px 20px", marginBottom:16, border:`1px solid ${warn?"#7f1d1d":"#1e293b"}` }}>{children}</div>;
}

function SLabel({ text, color="#64748b" }: { text:string; color?:string }) {
  return <div style={{ fontSize:11, color, fontWeight:700, textTransform:"uppercase" as const, letterSpacing:1, marginBottom:12 }}>{text}</div>;
}

function StatusBar({ msg, type }: { msg:string; type:ST }) {
  if (msg === "pool_warning" || msg === "ready") return null;
  return (
    <div style={{ background:"#111827", border:`1px solid ${SC[type]}`, borderRadius:10, padding:"11px 14px", marginBottom:20, color:SC[type], fontSize:13, lineHeight:1.6 }}>
      {type==="loading"&&"⟳ "}{msg}
    </div>
  );
}

// ── Live Pending Rewards Counter ──────────────────────────────────────────────
// Interpolates earned rewards in real-time between on-chain snapshots

function LiveRewards({ earnedRaw, staked, rateRaw, warn }: {
  earnedRaw: bigint; staked: bigint; rateRaw: bigint; warn: boolean;
}) {
  const [display, setDisplay] = useState("0.000000");
  const snapshotRef = useRef({ earnedRaw, staked, rateRaw, ts: Date.now() });

  // Reset snapshot whenever on-chain data updates
  useEffect(() => {
    snapshotRef.current = { earnedRaw, staked, rateRaw, ts: Date.now() };
  }, [earnedRaw, staked, rateRaw]);

  // Tick every 100ms, interpolating from snapshot
  useEffect(() => {
    const id = setInterval(() => {
      const { earnedRaw: base, staked: s, rateRaw: r, ts } = snapshotRef.current;
      if (s === 0n) { setDisplay(fmtBig(base, 6)); return; }
      const elapsedSec = (Date.now() - ts) / 1000;
      // per-user rate = (staked / totalStaked) × rewardRate — approximate with user share
      // We don't track totalStaked here, so use raw rateRaw as upper bound for display only
      const perUserRatePerSec = Number(ethers.formatUnits(r, 18)) * (Number(ethers.formatUnits(s, 18)));
      const accrued = perUserRatePerSec * elapsedSec;
      const total   = parseFloat(ethers.formatUnits(base, 18)) + accrued;
      setDisplay(total.toLocaleString(undefined, { minimumFractionDigits:6, maximumFractionDigits:6 }));
    }, 100);
    return () => clearInterval(id);
  }, []);

  return (
    <div style={{ background:warn?"#1c0a0a":"#111827", border:`1px solid ${warn?"#7f1d1d":"#1e293b"}`, borderRadius:12, padding:"14px 12px", textAlign:"center" }}>
      <div style={{ fontSize:11, color:"#64748b", marginBottom:5, textTransform:"uppercase" as const, letterSpacing:0.5 }}>
        Pending Rewards
        {!warn && <span style={{ marginLeft:6, fontSize:10, color:"#4ade80" }}>● LIVE</span>}
      </div>
      <div style={{ fontSize:15, fontWeight:700, color:warn?"#f87171":"#4ade80", fontVariantNumeric:"tabular-nums" }}>
        {display} IYK
      </div>
      {warn && <div style={{ fontSize:11, color:"#7f1d1d", marginTop:4 }}>⚠ Pool underfunded</div>}
    </div>
  );
}

// ── APR / APY Banner ──────────────────────────────────────────────────────────

function APRBanner({ rateRaw, totalStakedRaw, loading }: { rateRaw:bigint; totalStakedRaw:bigint; loading:boolean }) {
  const apr = calcAPR(rateRaw, totalStakedRaw);
  const apy = calcAPY(apr);
  const ratePerDay = totalStakedRaw > 0n
    ? (Number(ethers.formatUnits(rateRaw, 18)) * 86400 / Number(ethers.formatUnits(totalStakedRaw, 18)) * 100).toFixed(4)
    : "∞";

  return (
    <div style={{ background:"linear-gradient(135deg,#0d1f3c,#0a1a2e)", border:"1px solid #1e3a5f", borderRadius:14, padding:"18px 20px", marginBottom:16, display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap" as const, gap:12 }}>
      <div>
        <div style={{ fontSize:11, color:"#64748b", textTransform:"uppercase" as const, letterSpacing:1, marginBottom:4 }}>Staking Yield</div>
        <div style={{ fontSize:13, color:"#94a3b8" }}>Earn IYK by locking your tokens</div>
      </div>
      <div style={{ display:"flex", gap:20 }}>
        {[
          { label:"APR",        value:loading?"…":apr,           color:"#fbbf24" },
          { label:"APY",        value:loading?"…":apy,           color:"#34d399" },
          { label:"Daily Rate", value:loading?"…":`${ratePerDay}%`, color:"#818cf8" },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ textAlign:"center" as const }}>
            <div style={{ fontSize:11, color:"#64748b", marginBottom:4, textTransform:"uppercase" as const, letterSpacing:0.5 }}>{label}</div>
            <div style={{ fontSize:22, fontWeight:800, color }}>{value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Underfunded Warning Banner ────────────────────────────────────────────────

function UnderfundedBanner({ earnedRaw, poolRaw }: { earnedRaw:bigint; poolRaw:bigint }) {
  const shortage = earnedRaw > poolRaw ? fmtBig(earnedRaw - poolRaw, 2) : null;
  if (!shortage) return null;
  return (
    <div style={{ background:"linear-gradient(135deg,#1c0f03,#1a0a0a)", border:"1px solid #92400e", borderRadius:14, padding:"18px 20px", marginBottom:24, display:"flex", gap:14 }}>
      <span style={{ fontSize:26, flexShrink:0 }}>⚠️</span>
      <div>
        <div style={{ fontWeight:700, fontSize:15, color:"#fcd34d", marginBottom:6 }}>
          Rewards Temporarily Unavailable
        </div>
        <div style={{ fontSize:13, color:"#fbbf24", lineHeight:1.7 }}>
          The reward pool needs <strong>{shortage} IYK</strong> more funding before claims can be processed.
          Your earned rewards are secured on-chain — staking and unstaking continue normally.
        </div>
        <div style={{ marginTop:10, fontSize:12, color:"#92400e", background:"#1c0f03", border:"1px solid #78350f", borderRadius:8, padding:"8px 12px", display:"inline-block" }}>
          🔒 Your rewards are safe and will be claimable once the reward pool is replenished.
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

export default function Home() {
  // wallet
  const [walletConnected, setWalletConnected] = useState(false);
  const [walletAddress,   setWalletAddress]   = useState("");
  const [isAdmin,         setIsAdmin]         = useState(false);
  const [activeTab,       setActiveTab]       = useState<"user"|"admin">("user");

  // user on-chain data
  const [tokenBalance,   setTokenBalance]   = useState<string|null>(null);
  const [stakedRaw,      setStakedRaw]      = useState<bigint>(0n);
  const [earnedRaw,      setEarnedRaw]      = useState<bigint>(0n);
  const [stakingStartTs, setStakingStartTs] = useState(0);

  // contract state
  const [poolRaw,        setPoolRaw]        = useState<bigint>(0n);
  const [totalStakedRaw, setTotalStakedRaw] = useState<bigint>(0n);
  const [rateRaw,        setRateRaw]        = useState<bigint>(0n);
  const [cooldownSec,    setCooldownSec]    = useState(0);
  const [poolSufficient, setPoolSufficient] = useState<boolean|null>(null);
  const [isPaused,       setIsPaused]       = useState(false);
  const [isKilled,       setIsKilled]       = useState(false);
  const [totalSupply,    setTotalSupply]    = useState<string|null>(null);
  const [adminBalance,   setAdminBalance]   = useState<string|null>(null);

  const [loadingBal, setLoadingBal] = useState(false);
  const [lastRefresh,setLastRefresh]= useState<Date|null>(null);

  // inputs
  const [stakeAmount, setStakeAmount] = useState("");
  const [fundAmount,  setFundAmount]  = useState("");
  const [fundStep,    setFundStep]    = useState<"idle"|"approving"|"funding"|"done">("idle");
  const [sendTo,      setSendTo]      = useState("");
  const [sendAmt,     setSendAmt]     = useState("");
  const [newRate,     setNewRate]     = useState("");
  const [newCooldown, setNewCooldown] = useState("");
  const [excessAmt,   setExcessAmt]   = useState("");

  const [userStatus,  setUserStatus]  = useState<{message:string;type:ST}>({ message:"Connect your wallet to start staking.", type:"idle" });
  const [adminStatus, setAdminStatus] = useState<{message:string;type:ST}>({ message:"Admin panel ready.", type:"idle" });

  // ── fetch ──────────────────────────────────────────────────────────────────

  const fetchBalances = useCallback(async (address: string) => {
    setLoadingBal(true);
    try {
      const { provider } = await getPS();
      const tc = new ethers.Contract(TOKEN_ADDRESS,   TOKEN_ABI,   provider);
      const sc = new ethers.Contract(STAKING_ADDRESS, STAKING_ABI, provider);

      const [
        tBal, staked, earned, startTs,
        pool, totalSt, rate, cooldown,
        sufficient, paused, killed, supply,
      ] = await Promise.all([
        tc.balanceOf(address),
        sc.stakedBalance(address),
        sc.earned(address),
        sc.stakingStart(address),
        sc.contractRewardPool(),
        sc.totalStaked(),
        sc.rewardRate(),
        sc.unstakeCooldown(),
        sc.isPoolSufficient(),
        sc.paused(),
        sc.killed(),
        tc.totalSupply(),
      ]);

      setTokenBalance(ethers.formatUnits(tBal, 18));
      setAdminBalance(ethers.formatUnits(tBal, 18));
      setStakedRaw(staked as bigint);
      setEarnedRaw(earned as bigint);
      setStakingStartTs(Number(startTs));
      setPoolRaw(pool as bigint);
      setTotalStakedRaw(totalSt as bigint);
      setRateRaw(rate as bigint);
      setCooldownSec(Number(cooldown));
      setPoolSufficient(sufficient as boolean);
      setIsPaused(paused as boolean);
      setIsKilled(killed as boolean);
      setTotalSupply(ethers.formatUnits(supply, 18));
      setLastRefresh(new Date());

      if (!(sufficient as boolean) && (earned as bigint) > 0n) {
        setUserStatus({ message:"pool_warning", type:"warning" });
      } else if (userStatus.type !== "success") {
        setUserStatus({ message:"ready", type:"idle" });
      }
    } catch (e) { console.error("fetchBalances:", e); }
    finally { setLoadingBal(false); }
  }, []); // eslint-disable-line

  // Auto-refresh every 10 seconds for live feel
  useEffect(() => {
    if (!walletAddress) return;
    const id = setInterval(() => fetchBalances(walletAddress), 10000);
    return () => clearInterval(id);
  }, [walletAddress, fetchBalances]);

  // ── connect ────────────────────────────────────────────────────────────────

  const connectWallet = async () => {
    if (!(window as any).ethereum) { setUserStatus({ message:"Please install MetaMask.", type:"error" }); return; }
    try {
      setUserStatus({ message:"Switching to Sepolia…", type:"loading" });
      if (!await ensureSepolia()) { setUserStatus({ message:"Please switch MetaMask to Sepolia.", type:"error" }); return; }
      setUserStatus({ message:"Connecting…", type:"loading" });
      const { provider } = await getPS();
      const accounts = await provider.send("eth_requestAccounts", []);
      if (accounts.length > 0) {
        const addr = accounts[0];
        setWalletConnected(true);
        setWalletAddress(addr);
        const admin = addr.toLowerCase() === ADMIN_ADDRESS.toLowerCase();
        setIsAdmin(admin);
        await fetchBalances(addr);
        if (admin) setAdminStatus({ message:"Admin session active. All V2 controls unlocked.", type:"success" });
      }
    } catch (e: any) { setUserStatus({ message:decodeError(e), type:"error" }); }
  };

  // ── user actions ───────────────────────────────────────────────────────────

  const approveTokens = async () => {
    try {
      validateAmount(stakeAmount);
      setUserStatus({ message:"Approving tokens…", type:"loading" });
      const { signer } = await getPS();
      const tx = await new ethers.Contract(TOKEN_ADDRESS, TOKEN_ABI, signer)
        .approve(STAKING_ADDRESS, ethers.parseUnits(stakeAmount, 18));
      await tx.wait();
      setUserStatus({ message:"Approved! Now click Stake.", type:"success" });
    } catch (e: any) { setUserStatus({ message:decodeError(e), type:"error" }); }
  };

  const stakeTokens = async () => {
    try {
      validateAmount(stakeAmount);
      if (isPaused) { setUserStatus({ message:"Staking is currently paused.", type:"error" }); return; }
      setUserStatus({ message:"Staking tokens…", type:"loading" });
      const { signer } = await getPS();
      const tx = await new ethers.Contract(STAKING_ADDRESS, STAKING_ABI, signer)
        .stake(ethers.parseUnits(stakeAmount, 18));
      await tx.wait();
      setStakeAmount("");
      setUserStatus({ message:"Staked! Rewards are now accruing live.", type:"success" });
      await fetchBalances(walletAddress);
    } catch (e: any) { setUserStatus({ message:decodeError(e), type:"error" }); }
  };

  const claimRewards = async () => {
    try {
      if (earnedRaw === 0n) { setUserStatus({ message:"No rewards to claim yet.", type:"error" }); return; }
      if (!poolSufficient) { setUserStatus({ message:"pool_warning", type:"warning" }); return; }
      setUserStatus({ message:"Claiming rewards…", type:"loading" });
      const { signer } = await getPS();
      const tx = await new ethers.Contract(STAKING_ADDRESS, STAKING_ABI, signer).claimRewards();
      await tx.wait();
      setUserStatus({ message:`Claimed ${fmtBig(earnedRaw, 4)} IYK! 🎉`, type:"success" });
      await fetchBalances(walletAddress);
    } catch (e: any) { setUserStatus({ message:decodeError(e), type:"error" }); }
  };

  const unstakeTokens = async () => {
    try {
      validateAmount(stakeAmount);
      const cd = cooldownInfo(stakingStartTs, cooldownSec);
      if (cd.secs > 0) { setUserStatus({ message:`Cooldown active — ${cd.label}.`, type:"error" }); return; }
      setUserStatus({ message:"Unstaking…", type:"loading" });
      const { signer } = await getPS();
      const tx = await new ethers.Contract(STAKING_ADDRESS, STAKING_ABI, signer)
        .unstake(ethers.parseUnits(stakeAmount, 18));
      await tx.wait();
      setStakeAmount("");
      setUserStatus({ message:"Unstake successful!", type:"success" });
      await fetchBalances(walletAddress);
    } catch (e: any) { setUserStatus({ message:decodeError(e), type:"error" }); }
  };

  const emergencyExit = async () => {
    try {
      setUserStatus({ message:"Processing emergency exit…", type:"loading" });
      const { signer } = await getPS();
      const tx = await new ethers.Contract(STAKING_ADDRESS, STAKING_ABI, signer).emergencyUserExit();
      await tx.wait();
      setUserStatus({ message:"Emergency exit complete — rewards forfeited, stake returned.", type:"success" });
      await fetchBalances(walletAddress);
    } catch (e: any) { setUserStatus({ message:decodeError(e), type:"error" }); }
  };

  // ── admin actions ──────────────────────────────────────────────────────────

  const fundContract = async () => {
    try {
      validateAmount(fundAmount);
      const { signer } = await getPS();
      setFundStep("approving");
      setAdminStatus({ message:"Step 1/2 — Approving…", type:"loading" });
      const appTx = await new ethers.Contract(TOKEN_ADDRESS, TOKEN_ABI, signer)
        .approve(STAKING_ADDRESS, ethers.parseUnits(fundAmount, 18));
      await appTx.wait();
      setFundStep("funding");
      setAdminStatus({ message:"Step 2/2 — Funding reward pool…", type:"loading" });
      const tx = await new ethers.Contract(STAKING_ADDRESS, STAKING_ABI, signer)
        .fundRewardPool(ethers.parseUnits(fundAmount, 18));
      await tx.wait();
      setFundStep("done");
      setFundAmount("");
      setAdminStatus({ message:`✅ Reward pool funded with ${fundAmount} IYK!`, type:"success" });
      await fetchBalances(walletAddress);
      setTimeout(() => setFundStep("idle"), 3000);
    } catch (e: any) { setFundStep("idle"); setAdminStatus({ message:decodeError(e), type:"error" }); }
  };

  const updateRate = async () => {
    try {
      if (!newRate || Number(newRate) <= 0) throw new Error("Enter a valid rate.");
      setAdminStatus({ message:"Updating reward rate…", type:"loading" });
      const { signer } = await getPS();
      const tx = await new ethers.Contract(STAKING_ADDRESS, STAKING_ABI, signer)
        .setRewardRate(ethers.parseUnits(newRate, 18));
      await tx.wait();
      setNewRate("");
      setAdminStatus({ message:"✅ Reward rate updated!", type:"success" });
      await fetchBalances(walletAddress);
    } catch (e: any) { setAdminStatus({ message:decodeError(e), type:"error" }); }
  };

  const updateCooldown = async () => {
    try {
      if (!newCooldown || isNaN(Number(newCooldown))) throw new Error("Enter cooldown in seconds.");
      setAdminStatus({ message:"Updating cooldown…", type:"loading" });
      const { signer } = await getPS();
      const tx = await new ethers.Contract(STAKING_ADDRESS, STAKING_ABI, signer)
        .setUnstakeCooldown(Number(newCooldown));
      await tx.wait();
      setNewCooldown("");
      setAdminStatus({ message:"✅ Cooldown updated!", type:"success" });
      await fetchBalances(walletAddress);
    } catch (e: any) { setAdminStatus({ message:decodeError(e), type:"error" }); }
  };

  const togglePause = async () => {
    try {
      setAdminStatus({ message:isPaused?"Unpausing…":"Pausing…", type:"loading" });
      const { signer } = await getPS();
      const sc = new ethers.Contract(STAKING_ADDRESS, STAKING_ABI, signer);
      const tx = isPaused ? await sc.unpauseStaking() : await sc.pauseStaking();
      await tx.wait();
      setIsPaused(!isPaused);
      setAdminStatus({ message:isPaused?"✅ Contract unpaused.":"⏸ Contract paused.", type:"success" });
    } catch (e: any) { setAdminStatus({ message:decodeError(e), type:"error" }); }
  };

  const withdrawExcess = async () => {
    try {
      validateAmount(excessAmt);
      setAdminStatus({ message:"Withdrawing excess…", type:"loading" });
      const { signer } = await getPS();
      const tx = await new ethers.Contract(STAKING_ADDRESS, STAKING_ABI, signer)
        .withdrawExcessRewards(ethers.parseUnits(excessAmt, 18));
      await tx.wait();
      setExcessAmt("");
      setAdminStatus({ message:`✅ Withdrew ${excessAmt} IYK excess.`, type:"success" });
      await fetchBalances(walletAddress);
    } catch (e: any) { setAdminStatus({ message:decodeError(e), type:"error" }); }
  };

  const sendTokens = async () => {
    try {
      if (!sendTo.trim()) throw new Error("Enter a recipient.");
      try { ethers.getAddress(sendTo); } catch { throw new Error("Invalid address."); }
      validateAmount(sendAmt);
      setAdminStatus({ message:`Sending ${sendAmt} IYK…`, type:"loading" });
      const { signer } = await getPS();
      const tx = await new ethers.Contract(TOKEN_ADDRESS, TOKEN_ABI, signer)
        .transfer(sendTo, ethers.parseUnits(sendAmt, 18));
      await tx.wait();
      setSendTo(""); setSendAmt("");
      setAdminStatus({ message:"✅ Tokens sent!", type:"success" });
      await fetchBalances(walletAddress);
    } catch (e: any) { setAdminStatus({ message:decodeError(e), type:"error" }); }
  };

  // ── derived ────────────────────────────────────────────────────────────────

  const isLoading   = userStatus.type==="loading" || adminStatus.type==="loading";
  const amountValid = stakeAmount!==""&&Number(stakeAmount)>0;
  const fundValid   = fundAmount !==""&&Number(fundAmount) >0;
  const sendValid   = sendTo!==""&&sendAmt!==""&&Number(sendAmt)>0;
  const cd          = cooldownInfo(stakingStartTs, cooldownSec);
  const canClaim    = earnedRaw>0n && poolSufficient===true;
  const shortage    = earnedRaw>poolRaw && earnedRaw>0n ? earnedRaw-poolRaw : 0n;
  const apr         = calcAPR(rateRaw, totalStakedRaw);
  const coverPct    = poolCoverage(poolRaw, earnedRaw);

  const inputStyle: React.CSSProperties = {
    width:"100%", padding:"11px 14px", borderRadius:9,
    border:"1px solid #334155", background:"#0a0f1e",
    color:"white", fontSize:14, boxSizing:"border-box",
  };

  const quickFill = (bal: string | null, setter: (v:string)=>void) =>
    ["25%","50%","75%","Max"].map(label => (
      <button key={label} onClick={() => {
        if (!bal) return;
        const p = label==="Max"?1:parseInt(label)/100;
        setter((parseFloat(bal)*p).toFixed(4));
      }} style={{ flex:1, padding:"5px 0", borderRadius:6, border:"1px solid #334155", background:"#1e293b", color:"#94a3b8", fontSize:12, cursor:"pointer" }}>
        {label}
      </button>
    ));

  // ── render ─────────────────────────────────────────────────────────────────
  return (
    <main style={{ minHeight:"100vh", background:"#080d1a", color:"white", fontFamily:"'Segoe UI',system-ui,sans-serif", paddingBottom:60 }}>

      {/* ── Nav ── */}
      <nav style={{ background:"#0d1526", borderBottom:"1px solid #1e293b", padding:"14px 24px", display:"flex", justifyContent:"space-between", alignItems:"center", position:"sticky", top:0, zIndex:100 }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <span style={{ fontSize:22 }}>⚡</span>
          <div>
            <div style={{ fontWeight:800, fontSize:16 }}>IYK DeFi Protocol</div>
            <div style={{ fontSize:11, color:"#475569" }}>Advanced Secure Staking V2 · Sepolia</div>
          </div>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          {isPaused  && <Badge label="⏸ Paused"  color="#fb923c" />}
          {isKilled  && <Badge label="💀 Killed"  color="#f87171" />}
          {isAdmin&&walletConnected && <Badge label="👑 Admin"   color="#ca8a04" />}
          <button onClick={connectWallet} disabled={walletConnected||isLoading} style={{
            padding:"8px 18px", borderRadius:20, border:"none",
            background:walletConnected?"#166534":"#2563eb",
            color:"white", fontWeight:600, fontSize:13,
            cursor:walletConnected?"default":"pointer",
          }}>
            {walletConnected?`✓ ${walletAddress.slice(0,6)}…${walletAddress.slice(-4)}`:"Connect Wallet"}
          </button>
        </div>
      </nav>

      <div style={{ maxWidth:640, margin:"0 auto", padding:"28px 20px" }}>

        {/* Underfunded warning */}
        {walletConnected && !poolSufficient && poolSufficient!==null && earnedRaw>0n && (
          <UnderfundedBanner earnedRaw={earnedRaw} poolRaw={poolRaw} />
        )}

        {/* Tab switcher — admin only */}
        {isAdmin&&walletConnected && (
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:4, background:"#1e293b", borderRadius:14, padding:4, marginBottom:24 }}>
            {(["user","admin"] as const).map(tab => (
              <button key={tab} onClick={() => setActiveTab(tab)} style={{
                padding:"11px 0", borderRadius:10, border:"none",
                background:activeTab===tab?(tab==="admin"?"#ca8a04":"#2563eb"):"transparent",
                color:activeTab===tab?"white":"#64748b",
                fontWeight:700, fontSize:14, cursor:"pointer", transition:"all 0.2s",
              }}>
                {tab==="user"?"👤 User Dashboard":"👑 Admin V2"}
              </button>
            ))}
          </div>
        )}

        {/* ══════════════════════ USER DASHBOARD ══════════════════════ */}
        {activeTab==="user" && (
          <>
            <StatusBar msg={userStatus.message} type={userStatus.type} />

            {/* APR / APY Banner */}
            {walletConnected && (
              <APRBanner rateRaw={rateRaw} totalStakedRaw={totalStakedRaw} loading={loadingBal} />
            )}

            {/* Portfolio */}
            {walletConnected && (
              <Panel>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
                  <SLabel text="Your Portfolio" />
                  <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                    <span style={{ fontSize:11, color:"#334155" }}>
                      {lastRefresh ? `Updated ${lastRefresh.toLocaleTimeString()}` : ""}
                    </span>
                    <button onClick={() => fetchBalances(walletAddress)} disabled={loadingBal} style={{ fontSize:12, color:"#475569", background:"transparent", border:"none", cursor:"pointer" }}>
                      ↻
                    </button>
                  </div>
                </div>

                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:10 }}>
                  <StatCard label="Wallet Balance" value={`${fmt(tokenBalance)} IYK`} color="#38bdf8" loading={loadingBal} />
                  <StatCard label="Staked"         value={`${fmtBig(stakedRaw,4)} IYK`} color="#818cf8" loading={loadingBal} />
                </div>

                {/* Live pending rewards counter — full width */}
                <LiveRewards
                  earnedRaw={earnedRaw}
                  staked={stakedRaw}
                  rateRaw={rateRaw}
                  warn={!poolSufficient && poolSufficient!==null && earnedRaw>0n}
                />

                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginTop:10 }}>
                  <StatCard label="Current APR"     value={loadingBal?"…":apr}        color="#fbbf24" loading={false} />
                  <StatCard label="Unstake Cooldown" value={loadingBal?"…":cd.label}  color={cd.secs>0?"#fb923c":"#4ade80"} loading={false} />
                </div>
              </Panel>
            )}

            {/* Staking actions */}
            <Panel>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                <SLabel text="Stake & Earn" />
                {isPaused && <Badge label="⏸ Paused" color="#fb923c" />}
              </div>

              <input type="number" placeholder="Amount to stake / unstake" value={stakeAmount} min="0"
                onChange={(e) => { const v=e.target.value; if(v===""||Number(v)>=0) setStakeAmount(v); }}
                disabled={isLoading} style={{ ...inputStyle, marginBottom:10 }} />

              {walletConnected&&tokenBalance && (
                <div style={{ display:"flex", gap:6, marginBottom:14 }}>
                  {quickFill(tokenBalance, setStakeAmount)}
                </div>
              )}

              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:10 }}>
                <Btn label="Approve" color="#7c3aed" disabled={isLoading||!walletConnected||!amountValid} onClick={approveTokens} />
                <Btn label="Stake"   color="#2563eb" disabled={isLoading||!walletConnected||!amountValid||isPaused} onClick={stakeTokens} />
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
                <Btn label="Claim Rewards" color={canClaim?"#059669":"#1e3a2e"} disabled={isLoading||!walletConnected||!canClaim} onClick={claimRewards} />
                <Btn label="Unstake"       color="#dc2626" disabled={isLoading||!walletConnected||!amountValid||cd.secs>0} onClick={unstakeTokens} />
              </div>

              {/* Inline underfunded notice */}
              {!poolSufficient&&walletConnected&&poolSufficient!==null&&earnedRaw>0n && (
                <div style={{ marginTop:12, background:"#1c0f03", border:"1px solid #78350f", borderRadius:9, padding:"10px 14px", fontSize:12, color:"#fbbf24", lineHeight:1.6 }}>
                  ⚠️ <strong>Claim disabled.</strong> The reward pool needs {fmtBig(shortage,2)} more IYK. Your earned rewards are safe on-chain.
                </div>
              )}
            </Panel>

            {/* Emergency exit */}
            {walletConnected&&stakedRaw>0n && (
              <Panel warn>
                <SLabel text="⚠ Emergency Exit" color="#f87171" />
                <p style={{ fontSize:13, color:"#64748b", margin:"0 0 14px", lineHeight:1.6 }}>
                  Instantly unstake everything, bypassing cooldown.{" "}
                  <strong style={{ color:"#f87171" }}>All pending rewards will be permanently forfeited.</strong>
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

        {/* ══════════════════════ ADMIN DASHBOARD ══════════════════════ */}
        {activeTab==="admin" && !isAdmin && (
          <div style={{ textAlign:"center" as const, padding:"80px 0" }}>
            <div style={{ fontSize:56, marginBottom:16 }}>⛔</div>
            <div style={{ fontWeight:700, fontSize:18, color:"#f87171" }}>Access Denied</div>
            <div style={{ color:"#64748b", fontSize:14, marginTop:8 }}>Restricted to contract owner only.</div>
          </div>
        )}

        {activeTab==="admin" && isAdmin && (
          <>
            <StatusBar msg={adminStatus.message} type={adminStatus.type} />

            {/* Admin underfunded banner */}
            {!poolSufficient&&poolSufficient!==null&&earnedRaw>0n && (
              <div style={{ background:"#1c0a0a", border:"1px solid #7f1d1d", borderRadius:12, padding:"14px 18px", marginBottom:16, display:"flex", justifyContent:"space-between", alignItems:"center", gap:12 }}>
                <div>
                  <div style={{ fontWeight:700, color:"#f87171", marginBottom:4 }}>🚨 Reward Pool Underfunded</div>
                  <div style={{ fontSize:13, color:"#fca5a5" }}>
                    Contract needs <strong>{fmtBig(shortage,2)} IYK</strong> more to cover all earned rewards.
                    Fund the pool immediately to unblock user claims.
                  </div>
                </div>
                <button onClick={() => { setFundAmount(fmtBig(shortage,4).replace(/,/g,"")); }} style={{ padding:"8px 16px", borderRadius:8, border:"1px solid #f87171", background:"transparent", color:"#f87171", fontSize:12, fontWeight:700, cursor:"pointer", whiteSpace:"nowrap" as const }}>
                  Use Deficit ↓
                </button>
              </div>
            )}

            {/* Protocol health */}
            <Panel>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                <SLabel text="📊 Protocol Health" />
                <button onClick={() => fetchBalances(walletAddress)} disabled={loadingBal} style={{ fontSize:12, color:"#475569", background:"transparent", border:"none", cursor:"pointer" }}>
                  ↻ {lastRefresh?.toLocaleTimeString()??"Refresh"}
                </button>
              </div>

              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10, marginBottom:10 }}>
                <StatCard label="Reward Pool"  value={`${fmtBig(poolRaw,2)} IYK`}          color={!poolSufficient?"#f87171":"#4ade80"} loading={loadingBal} warn={!poolSufficient&&poolSufficient!==null} />
                <StatCard label="Total Staked" value={`${fmtBig(totalStakedRaw,2)} IYK`}   color="#818cf8" loading={loadingBal} />
                <StatCard label="APR"          value={loadingBal?"…":apr}                   color="#fbbf24" loading={false} />
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10, marginBottom:14 }}>
                <StatCard label="Admin Balance" value={`${fmt(adminBalance,2)} IYK`}         color="#38bdf8" loading={loadingBal} />
                <StatCard label="Total Supply"  value={`${fmt(totalSupply,0)} IYK`}          color="#e2e8f0" loading={loadingBal} />
                <StatCard label="Pool Status"   value={poolSufficient===null?"—":poolSufficient?"✓ Healthy":"⚠ Underfunded"} color={poolSufficient?"#4ade80":"#f87171"} loading={loadingBal} />
              </div>

              {/* Coverage bar */}
              <div style={{ marginBottom:14 }}>
                <div style={{ display:"flex", justifyContent:"space-between", marginBottom:6 }}>
                  <span style={{ fontSize:12, color:"#64748b" }}>Reward Pool Coverage</span>
                  <span style={{ fontSize:12, fontWeight:600, color:coverPct>=100?"#4ade80":coverPct>=50?"#facc15":"#f87171" }}>
                    {earnedRaw===0n?"100":coverPct.toFixed(1)}%
                  </span>
                </div>
                <div style={{ background:"#0a0f1e", borderRadius:99, height:12, overflow:"hidden" }}>
                  <div style={{
                    height:"100%", borderRadius:99, transition:"width 0.6s ease",
                    width:`${earnedRaw===0n?100:Math.min(100,coverPct)}%`,
                    background:coverPct>=100?"#4ade80":coverPct>=50?"#facc15":"#f87171",
                  }} />
                </div>
                <div style={{ fontSize:11, color:"#334155", marginTop:4 }}>100% = contract can fully pay all earned rewards</div>
              </div>

              {/* Pause button */}
              <button onClick={togglePause} disabled={isLoading||isKilled} style={{ width:"100%", padding:11, borderRadius:9, border:"none", background:isPaused?"#166534":"#92400e", color:"white", fontWeight:700, fontSize:13, cursor:isLoading||isKilled?"not-allowed":"pointer" }}>
                {isPaused?"▶ Unpause Staking":"⏸ Pause Staking"}
              </button>
            </Panel>

            {/* Fund reward pool */}
            <Panel>
              <SLabel text="🏦 Fund Reward Pool" />
              <p style={{ fontSize:13, color:"#64748b", margin:"0 0 14px", lineHeight:1.6 }}>
                Deposit IYK into the reward pool so users can claim earned rewards. Requires 2 transactions: Approve → Fund.
              </p>

              {fundStep!=="idle" && (
                <div style={{ display:"flex", gap:6, marginBottom:14, alignItems:"center" }}>
                  {(["approving","funding","done"] as const).map((s, i) => {
                    const order = ["idle","approving","funding","done"];
                    const cur=order.indexOf(fundStep), mine=order.indexOf(s);
                    return (
                      <div key={s} style={{ display:"flex", alignItems:"center", gap:6 }}>
                        {i>0&&<div style={{ height:1, width:16, background:cur>mine?"#ca8a04":"#334155" }} />}
                        <div style={{ padding:"4px 10px", borderRadius:20, fontSize:12, fontWeight:600, background:cur>mine?"#78350f":cur===mine?"#ca8a04":"#1e293b", color:cur>=mine?"white":"#64748b" }}>
                          {s==="approving"?"1. Approve":s==="funding"?"2. Fund":"✓ Done"}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <label style={{ fontSize:12, color:"#64748b", display:"block", marginBottom:6 }}>Amount (IYK)</label>
              <input type="number" placeholder="e.g. 100000" value={fundAmount} min="0"
                onChange={(e) => { const v=e.target.value; if(v===""||Number(v)>=0) setFundAmount(v); }}
                disabled={isLoading} style={{ ...inputStyle, marginBottom:8 }} />
              <div style={{ display:"flex", gap:6, marginBottom:14 }}>
                {quickFill(adminBalance, setFundAmount)}
              </div>
              <Btn
                label={fundStep==="approving"?"⟳ Approving…":fundStep==="funding"?"⟳ Funding…":fundStep==="done"?"✓ Funded!":"💰 Approve & Fund Pool"}
                color="#ca8a04" disabled={isLoading||!fundValid} onClick={fundContract} />
            </Panel>

            {/* Contract controls */}
            <Panel>
              <SLabel text="⚙️ Contract Controls" />
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16, marginBottom:16 }}>
                <div>
                  <label style={{ fontSize:12, color:"#64748b", display:"block", marginBottom:6 }}>Reward Rate (IYK/sec)</label>
                  <input type="number" placeholder="e.g. 0.0001" value={newRate}
                    onChange={(e) => setNewRate(e.target.value)} disabled={isLoading}
                    style={{ ...inputStyle, marginBottom:8 }} />
                  <Btn label="Update Rate" color="#0ea5e9" disabled={isLoading||!newRate} onClick={updateRate} />
                </div>
                <div>
                  <label style={{ fontSize:12, color:"#64748b", display:"block", marginBottom:6 }}>Cooldown (seconds)</label>
                  <input type="number" placeholder="e.g. 86400" value={newCooldown}
                    onChange={(e) => setNewCooldown(e.target.value)} disabled={isLoading}
                    style={{ ...inputStyle, marginBottom:8 }} />
                  <Btn label="Update Cooldown" color="#0ea5e9" disabled={isLoading||!newCooldown} onClick={updateCooldown} />
                </div>
              </div>
              <label style={{ fontSize:12, color:"#64748b", display:"block", marginBottom:6 }}>Withdraw Excess Rewards (IYK)</label>
              <div style={{ display:"flex", gap:10 }}>
                <input type="number" placeholder="Amount" value={excessAmt}
                  onChange={(e) => setExcessAmt(e.target.value)} disabled={isLoading}
                  style={{ ...inputStyle, flex:1 }} />
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
                style={{ ...inputStyle, marginBottom:10, border:`1px solid ${sendTo && isInvalidAddr(sendTo) ? "#f87171" : "#334155"}` }} />
              <label style={{ fontSize:12, color:"#64748b", display:"block", marginBottom:6 }}>Amount (IYK)</label>
              <input type="number" placeholder="e.g. 1000" value={sendAmt} min="0"
                onChange={(e) => { const v=e.target.value; if(v===""||Number(v)>=0) setSendAmt(v); }}
                disabled={isLoading} style={{ ...inputStyle, marginBottom:14 }} />
              <Btn label={isLoading?"⟳ Sending…":"Send IYK"} color="#0ea5e9" disabled={isLoading||!sendValid} onClick={sendTokens} />
            </Panel>

            {/* Contract info */}
            <div style={{ background:"#111827", borderRadius:10, padding:"14px 16px", fontSize:11, color:"#334155", wordBreak:"break-all" as const, border:"1px solid #1e293b" }}>
              <div><span style={{ color:"#475569" }}>V2 Contract: </span>{STAKING_ADDRESS}</div>
              <div style={{ marginTop:4 }}><span style={{ color:"#475569" }}>Token:       </span>{TOKEN_ADDRESS}</div>
              <div style={{ marginTop:4 }}><span style={{ color:"#475569" }}>Admin:       </span>{walletAddress}</div>
            </div>
          </>
        )}
      </div>

      <style>{`
        @keyframes tick { 0%,100%{opacity:1} 50%{opacity:0.6} }
        button:hover:not(:disabled) { filter:brightness(1.1); }
        input:focus { outline:none; border-color:#3b82f6!important; }
      `}</style>
    </main>
  );
}
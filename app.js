"use strict";
/* =====================================================================
   DropLedger frontend — plain JS + ethers v6, no build step.

   >>> DEPLOYMENT CONFIG: paste the deployed DropLedger address per chain
   >>> here after deploying (see README.md). Until then the app shows a
   >>> "not deployed on this network yet" notice.
   ===================================================================== */
const CONFIG = {
  contracts: {
    56: "0x0000000000000000000000000000000000000000", // BNB Chain mainnet
    97: "0xC0C3161Ce1939E406188511A9De116C24C12085d", // BNB Chain testnet (Chapel) — deployed 2026-11-18, mock Agent ID 0xE07526278aE990420219669341E0589A5e2e074E
  },
  agentId: "0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F", // SPACE ID Agent ID (ERC-721)
  chains: {
    56: { name: "BNB Chain", rpc: "https://bsc.publicnode.com", explorer: "https://bscscan.com" },
    97: {
      name: "BNB Chain Testnet",
      rpc: "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
      explorer: "https://testnet.bscscan.com",
    },
  },
};

// Demo journal shown by default on testnet (the deployer's journal — it
// holds the "Fungo" test project). Lets first-time visitors see a real
// journal without connecting a wallet.
const EXAMPLE_JOURNAL = "0x350A851D8BB7A2A1202f6D411d57707734375b52";
// Default chain: mainnet once the contract is deployed there, else testnet.
const DEFAULT_CHAIN =
  CONFIG.contracts[56] !== "0x0000000000000000000000000000000000000000" ? 56 : 97;

const ABI = [
  "function createProject(string name, string chainName, string walletLabel, string notes) returns (uint256)",
  "function updateProjectStatus(uint256 projectId, uint8 status)",
  "function updateProjectNotes(uint256 projectId, string notes)",
  "function addTask(uint256 projectId, string title, uint8 kind, bool recurring) returns (uint256)",
  "function addTasksBatch(uint256 projectId, string[] titles, uint8[] kinds, bool[] recurrings) returns (uint256)",
  "function setTaskDone(uint256 projectId, uint256 taskId, bool done)",
  "function getProjectCount(address user) view returns (uint256)",
  "function getProject(address user, uint256 projectId) view returns (tuple(string name, string chainName, string walletLabel, string notes, uint8 status, uint64 createdAt, uint64 lastActivityAt, uint32 taskCount, uint32 tasksDone))",
  "function getTaskCount(address user, uint256 projectId) view returns (uint256)",
  "function getTask(address user, uint256 projectId, uint256 taskId) view returns (tuple(string title, uint8 kind, bool recurring, bool done, uint64 createdAt, uint64 completedAt))",
  "function getStats(address user) view returns (uint256 projectCount, uint256 tasksDone, uint256 tasksRemaining)",
  "function isAgentHolder(address user) view returns (bool)",
];

const STATUS = ["Active", "Paused", "Ended", "TGE"];
const KIND = ["Social", "On-chain", "Testnet", "Daily", "Weekly", "Other"];

/* ---------------- state ---------------- */
let provider = null; // BrowserProvider (only when a wallet is connected)
let readProvider = null; // JsonRpcProvider (public RPC) — reads work without a wallet
let signer = null;
let account = null;
let chainId = DEFAULT_CHAIN; // app-selected chain (56 or 97)
let walletChainId = null; // chain the connected wallet is actually on
let readContract = null; // connected to readProvider
let writeContract = null; // connected to signer
let viewing = null; // address whose journal is shown (account by default)
let canWrite = false;
let projectsCache = [];

/* ---------------- dom helpers ---------------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const show = (el) => el.classList.remove("hidden");
const hide = (el) => el.classList.add("hidden");
const toastEl = $("#toast");
let toastTimer = null;

function toast(msg, kind = "") {
  toastEl.textContent = msg;
  toastEl.className = "toast " + kind;
  show(toastEl);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => hide(toastEl), 4500);
}

function shortAddr(a) {
  return a ? a.slice(0, 6) + "…" + a.slice(-4) : "";
}

function timeAgo(ts) {
  const s = Math.floor(Date.now() / 1000) - Number(ts);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  if (s < 86400 * 30) return Math.floor(s / 86400) + "d ago";
  return new Date(Number(ts) * 1000).toLocaleDateString();
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/* ---------------- wallet / network ---------------- */
function contractAddress() {
  if (!chainId) return null;
  const a = CONFIG.contracts[chainId];
  return a && a !== ethers.ZeroAddress ? a : null;
}

// Reads always go through the public RPC, so they work with or without a
// connected wallet.
function buildReadContract() {
  const addr = contractAddress();
  if (!addr) {
    readContract = null;
    readProvider = null;
    return;
  }
  readProvider = new ethers.JsonRpcProvider(CONFIG.chains[chainId].rpc);
  readContract = new ethers.Contract(addr, ABI, readProvider);
}

// Writes need a connected wallet; rebuilt whenever the chain changes.
function buildWriteContract() {
  const addr = contractAddress();
  writeContract = addr && signer ? new ethers.Contract(addr, ABI, signer) : null;
}

async function connect() {
  if (!window.ethereum) {
    toast("No wallet found. Open this page in Binance Wallet or MetaMask.", "error");
    return;
  }
  try {
    provider = new ethers.BrowserProvider(window.ethereum);
    const accounts = await provider.send("eth_requestAccounts", []);
    account = accounts[0];
    signer = await provider.getSigner();
    walletChainId = Number((await provider.getNetwork()).chainId);
    viewing = account;
    setupWalletListeners();
    await refreshAll();
  } catch (e) {
    toast("Connection failed: " + friendlyError(e), "error");
  }
}

let listenersSet = false;
function setupWalletListeners() {
  if (listenersSet || !window.ethereum) return;
  listenersSet = true;
  window.ethereum.on("accountsChanged", (accs) => {
    account = accs[0] || null;
    viewing = account;
    if (account) refreshAll();
    else location.reload();
  });
  window.ethereum.on("chainChanged", () => location.reload());
}

async function switchNetwork(target) {
  const hex = "0x" + target.toString(16);
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: hex }],
    });
  } catch (e) {
    // 4902: chain not added to the wallet — add it, then switch.
    if (e && e.code === 4902) {
      const c = CONFIG.chains[target];
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: hex,
          chainName: c.name,
          nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
          rpcUrls: [c.rpc],
          blockExplorerUrls: [c.explorer],
        }],
      });
    } else {
      throw e;
    }
  }
}

/* ---------------- loading & rendering ---------------- */
async function refreshAll() {
  // The app section is always visible; only the hero hides once connected.
  if (account) hide($("#connectPrompt"));
  else show($("#connectPrompt"));
  show($("#app"));
  $("#accountLabel").textContent = account ? shortAddr(account) : "Read-only mode";
  $("#networkLabel").textContent = CONFIG.chains[chainId].name;
  $("#switchNetBtn").textContent =
    chainId === 56 ? "Switch to testnet" : "Switch to mainnet";
  hide($("#netBanner"));

  buildReadContract();
  buildWriteContract();

  // Not-deployed state.
  const addr = contractAddress();
  if (!addr) {
    $("#notDeployedBanner").textContent =
      "DropLedger is not deployed on " + CONFIG.chains[chainId].name +
      " yet. Switch networks or check back after deployment.";
    show($("#notDeployedBanner"));
    $("#statProjects").textContent = "–";
    $("#statDone").textContent = "–";
    $("#statLeft").textContent = "–";
    $("#projectList").innerHTML = "";
    hide($("#emptyState"));
    return;
  }
  hide($("#notDeployedBanner"));

  // Agent ID gate (only matters when viewing your own journal with a wallet).
  canWrite = !!(account && viewing === account &&
    (await readContract.isAgentHolder(account)));
  if (!account) {
    $("#noAgentBanner").innerHTML =
      "You are browsing in <b>read-only</b> mode. Connect your wallet to " +
      "open your own journal and write entries (needs an Agent ID).";
    show($("#noAgentBanner"));
  } else if (viewing === account && !canWrite) {
    $("#noAgentBanner").innerHTML =
      "This wallet holds no Agent ID, so this journal is <b>read-only</b>. " +
      "Writing needs an Agent ID — claim one free in the Binance App " +
      "(Wallet &gt; Agent ID banner).";
    show($("#noAgentBanner"));
  } else {
    hide($("#noAgentBanner"));
  }
  $("#addProjectWrap").classList.toggle("hidden", !canWrite);
  $("#myJournalBtn").classList.toggle("hidden", !account || viewing === account);
  $("#projectsTitle").textContent =
    account && viewing === account ? "Your projects" : "Projects";

  await loadJournal();
}

async function loadJournal() {
  const list = $("#projectList");
  list.innerHTML = "";
  projectsCache = [];
  if (!viewing) {
    $("#statProjects").textContent = "–";
    $("#statDone").textContent = "–";
    $("#statLeft").textContent = "–";
    $("#emptyState").textContent =
      "No journal selected. Paste a wallet address above, open the example " +
      "journal, or connect your wallet.";
    show($("#emptyState"));
    return;
  }
  try {
    const [pc, done, left] = await readContract.getStats(viewing);
    $("#statProjects").textContent = pc.toString();
    $("#statDone").textContent = done.toString();
    $("#statLeft").textContent = left.toString();

    const count = Number(pc);
    $("#emptyState").textContent =
      "No projects yet. Add your first project above — your journal starts " +
      "with one entry.";
    $("#emptyState").classList.toggle("hidden", count !== 0);
    for (let i = 0; i < count; i++) {
      const p = await readContract.getProject(viewing, i);
      projectsCache.push(p);
      list.appendChild(renderProject(i, p));
    }
  } catch (e) {
    toast("Could not load the journal: " + friendlyError(e), "error");
  }
}

function renderProject(id, p) {
  const tpl = $("#projectTpl");
  const node = tpl.content.firstElementChild.cloneNode(true);
  node.dataset.pid = id;

  $(".proj-name", node).textContent = p.name;
  $(".proj-meta", node).textContent =
    (p.chainName || "—") + (p.walletLabel ? " · wallet: " + p.walletLabel : "");
  const badge = $(".badge", node);
  badge.textContent = STATUS[p.status];
  badge.classList.add(STATUS[p.status]);

  const pct = p.taskCount > 0
    ? Math.round((Number(p.tasksDone) / Number(p.taskCount)) * 100)
    : 0;
  $(".bar", node).style.width = pct + "%";
  $(".proj-sub", node).textContent =
    Number(p.tasksDone) + "/" + Number(p.taskCount) + " tasks done · " +
    pct + "% · last activity " + timeAgo(p.lastActivityAt);

  $(".proj-notes", node).textContent = p.notes || "";
  $(".proj-notes", node).classList.toggle("hidden", !p.notes);
  const sel = $(".statusSel", node);
  sel.value = String(p.status);
  sel.disabled = !canWrite;

  // Expand / collapse + lazy-load tasks.
  $(".proj-head", node).addEventListener("click", async () => {
    const open = node.classList.toggle("open");
    const body = $(".proj-body", node);
    body.classList.toggle("hidden", !open);
    if (open && !node.dataset.tasksLoaded) {
      node.dataset.tasksLoaded = "1";
      await loadTasks(node, id);
    }
  });

  // Write controls hidden when read-only.
  $$(".addTaskForm, .batch, .proj-actions", node).forEach((el) =>
    el.classList.toggle("hidden", !canWrite));

  sel.addEventListener("change", () =>
    writeTx(
      () => writeContract.updateProjectStatus(id, Number(sel.value)),
      "Status updated."
    ).catch(() => { sel.value = String(p.status); })
  );

  $(".editNotesBtn", node).addEventListener("click", () => {
    const f = $(".notesForm", node);
    f.classList.toggle("hidden");
    $("textarea", f).value = p.notes || "";
  });
  $(".notesForm", node).addEventListener("submit", async (e) => {
    e.preventDefault();
    const notes = $("textarea", e.target).value;
    await writeTx(
      () => writeContract.updateProjectNotes(id, notes),
      "Notes saved."
    );
    p.notes = notes;
    $(".proj-notes", node).textContent = notes;
    $(".proj-notes", node).classList.toggle("hidden", !notes);
    e.target.classList.add("hidden");
  });

  $(".addTaskForm", node).addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const title = f.title.value.trim();
    if (!title) return;
    await writeTx(
      () => writeContract.addTask(id, title, Number(f.kind.value), f.recurring.checked),
      "Task added."
    );
    f.reset();
    await loadTasks(node, id, true);
    await refreshStatsOnly();
  });

  $(".batchBtn", node).addEventListener("click", async () => {
    const box = $(".batch", node);
    const titles = $("textarea", box).value.split("\n").map((s) => s.trim()).filter(Boolean);
    if (titles.length === 0) return;
    const kind = Number($("select", box).value);
    const kinds = titles.map(() => kind);
    const recs = titles.map(() => false);
    await writeTx(
      () => writeContract.addTasksBatch(id, titles, kinds, recs),
      titles.length + " tasks added in one transaction."
    );
    $("textarea", box).value = "";
    await loadTasks(node, id, true);
    await refreshStatsOnly();
  });

  return node;
}

async function loadTasks(node, pid, force = false) {
  const ul = $(".tasks", node);
  if (!force && ul.childElementCount > 0) return;
  ul.innerHTML = "";
  const n = Number(await readContract.getTaskCount(viewing, pid));
  if (n === 0) {
    ul.innerHTML = "<li class='muted'>No tasks yet.</li>";
    return;
  }
  for (let i = 0; i < n; i++) {
    const t = await readContract.getTask(viewing, pid, i);
    const li = $("#taskTpl").content.firstElementChild.cloneNode(true);
    if (t.done) li.classList.add("done");
    $(".task-title", li).textContent = t.title;
    $(".task-meta", li).textContent =
      KIND[t.kind] + (t.recurring ? " · ↻" : "") + (t.done && t.completedAt > 0 ? " · ✓ " + timeAgo(t.completedAt) : "");
    const box = $(".taskDone", li);
    box.checked = t.done;
    box.disabled = !canWrite;
    box.addEventListener("change", async () => {
      const want = box.checked;
      await writeTx(
        () => writeContract.setTaskDone(pid, i, want),
        want ? "Task done. Nice." : "Task reopened."
      );
      li.classList.toggle("done", want);
      await refreshStatsOnly();
      // Refresh the project's progress bar.
      const p = await readContract.getProject(viewing, pid);
      projectsCache[pid] = p;
      const pct = p.taskCount > 0 ? Math.round((Number(p.tasksDone) / Number(p.taskCount)) * 100) : 0;
      $(".bar", node).style.width = pct + "%";
      $(".proj-sub", node).textContent =
        Number(p.tasksDone) + "/" + Number(p.taskCount) + " tasks done · " +
        pct + "% · last activity " + timeAgo(p.lastActivityAt);
    });
    ul.appendChild(li);
  }
}

async function refreshStatsOnly() {
  try {
    const [, done, left] = await readContract.getStats(viewing);
    $("#statDone").textContent = done.toString();
    $("#statLeft").textContent = left.toString();
  } catch (e) { /* stats refresh is best-effort */ }
}

/* ---------------- writes ---------------- */
async function writeTx(fn, okMsg) {
  try {
    if (!signer || !writeContract) {
      toast("Connect your wallet to write.", "error");
      throw new Error("no wallet");
    }
    // The app chain and the wallet chain can differ (reads use the public
    // RPC). Never send a write to the wrong chain — switch first, then
    // ask the user to retry the click.
    const wnet = await provider.getNetwork();
    if (Number(wnet.chainId) !== chainId) {
      await switchNetwork(chainId);
      toast("Wallet switched to " + CONFIG.chains[chainId].name +
        ". Please try again.", "ok");
      const retry = new Error("chain switched, retry");
      retry.retry = true;
      throw retry;
    }
    toast("Waiting for your confirmation in the wallet…");
    const tx = await fn();
    toast("Transaction sent — waiting for confirmation…");
    await tx.wait();
    toast(okMsg, "ok");
  } catch (e) {
    if (e && e.retry) throw e; // already explained above, no error toast
    toast("Transaction failed: " + friendlyError(e), "error");
    throw e;
  }
}

function friendlyError(e) {
  if (!e) return "unknown error";
  if (e.code === 4001 || /user rejected/i.test(e.message || "")) return "rejected in wallet";
  if (e.code === "CALL_EXCEPTION" || /AgentIdRequired/i.test(String(e))) return "this wallet holds no Agent ID";
  const m = (e.shortMessage || e.reason || e.message || String(e)).slice(0, 140);
  return m;
}

/* ---------------- top-level wiring ---------------- */
$("#connectBtn").addEventListener("click", connect);
$$("[data-connect]").forEach((b) => b.addEventListener("click", connect));

$("#switchNetBtn").addEventListener("click", async () => {
  const target = chainId === 56 ? 97 : 56;
  localStorage.setItem("dl-chain", String(target));
  if (account) {
    // With a wallet, switch the wallet itself (chainChanged reloads the
    // page; the saved chain is restored by init()).
    try {
      await switchNetwork(target);
    } catch (e) {
      toast("Could not switch network: " + friendlyError(e), "error");
    }
  } else {
    // Read-only: just point the reads at the other chain.
    chainId = target;
    await refreshAll();
  }
});

$("#viewBtn").addEventListener("click", async () => {
  const v = $("#viewAddr").value.trim();
  if (!ethers.isAddress(v)) {
    toast("That is not a valid wallet address.", "error");
    return;
  }
  viewing = v;
  history.replaceState(null, "", "?address=" + v);
  await refreshAll();
});

$("#exampleBtn").addEventListener("click", async () => {
  $("#viewAddr").value = EXAMPLE_JOURNAL;
  viewing = EXAMPLE_JOURNAL;
  history.replaceState(null, "", "?address=" + EXAMPLE_JOURNAL);
  await refreshAll();
});

$("#myJournalBtn").addEventListener("click", async () => {
  viewing = account;
  $("#viewAddr").value = "";
  history.replaceState(null, "", location.pathname);
  await refreshAll();
});

$("#toggleAddProject").addEventListener("click", () => {
  const f = $("#addProjectForm");
  const open = f.classList.toggle("hidden");
  $("#toggleAddProject").setAttribute("aria-expanded", String(!open));
});

$("#addProjectForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const name = f.name.value.trim();
  if (!name) return;
  await writeTx(
    () => writeContract.createProject(name, f.chainName.value.trim(), f.walletLabel.value.trim(), f.notes.value.trim()),
    "Project saved on-chain."
  );
  f.reset();
  f.classList.add("hidden");
  await loadJournal();
});

// Boot: read-only mode by default (public RPC), wallet is optional.
// Auto-reconnects if the wallet is already authorized.
(async function init() {
  // Restore the last-used chain (defaults to testnet until mainnet deploys).
  try {
    const saved = Number(localStorage.getItem("dl-chain"));
    if (saved === 56 || saved === 97) chainId = saved;
  } catch (e) { /* storage unavailable — keep the default chain */ }

  // Deep link: ?address=0x... opens that journal directly.
  try {
    const q = new URLSearchParams(location.search).get("address");
    if (q && ethers.isAddress(q)) viewing = q;
  } catch (e) { /* ignore a malformed query string */ }

  if (window.ethereum) {
    try {
      provider = new ethers.BrowserProvider(window.ethereum);
      const accounts = await provider.send("eth_accounts", []);
      if (accounts.length > 0) {
        account = accounts[0];
        signer = await provider.getSigner();
        walletChainId = Number((await provider.getNetwork()).chainId);
        viewing = account;
        setupWalletListeners();
      }
    } catch (e) { /* stay in read-only mode */ }
  }

  // Default demo journal on testnet so first-time visitors see a real journal.
  if (!viewing && chainId === 97) viewing = EXAMPLE_JOURNAL;
  await refreshAll();
})();

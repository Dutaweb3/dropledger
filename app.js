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
let provider = null; // BrowserProvider
let signer = null;
let account = null;
let chainId = null;
let readContract = null; // connected to provider
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
    const net = await provider.getNetwork();
    chainId = Number(net.chainId);
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
  hide($("#connectPrompt"));
  show($("#app"));
  $("#accountLabel").textContent = shortAddr(account);
  const supported = chainId === 56 || chainId === 97;
  $("#networkLabel").textContent = supported
    ? CONFIG.chains[chainId].name
    : "Unsupported network (" + chainId + ")";
  $("#switchNetBtn").textContent =
    chainId === 56 ? "Switch to testnet" : "Switch to mainnet";

  // Wrong-network state.
  if (!supported) {
    $("#netBanner").innerHTML =
      "You are on an unsupported network. DropLedger runs on BNB Chain " +
      "(mainnet 56) and BNB Chain Testnet (97).";
    show($("#netBanner"));
    hide($("#projectList").parentElement);
    return;
  }
  hide($("#netBanner"));

  // Not-deployed state.
  const addr = contractAddress();
  if (!addr) {
    $("#notDeployedBanner").textContent =
      "DropLedger is not deployed on " + CONFIG.chains[chainId].name +
      " yet. Switch networks or check back after deployment.";
    show($("#notDeployedBanner"));
    return;
  }
  hide($("#notDeployedBanner"));

  readContract = new ethers.Contract(addr, ABI, provider);
  writeContract = new ethers.Contract(addr, ABI, signer);

  // Agent ID gate (only matters when viewing your own journal).
  canWrite = viewing === account && (await readContract.isAgentHolder(account));
  if (viewing === account && !canWrite) {
    $("#noAgentBanner").innerHTML =
      "This wallet holds no Agent ID, so this journal is <b>read-only</b>. " +
      "Writing needs an Agent ID — claim one free in the Binance App " +
      "(Wallet &gt; Agent ID banner).";
    show($("#noAgentBanner"));
  } else {
    hide($("#noAgentBanner"));
  }
  $("#addProjectWrap").classList.toggle("hidden", !canWrite);
  $("#myJournalBtn").classList.toggle("hidden", viewing === account);

  await loadJournal();
}

async function loadJournal() {
  const list = $("#projectList");
  list.innerHTML = "";
  projectsCache = [];
  try {
    const [pc, done, left] = await readContract.getStats(viewing);
    $("#statProjects").textContent = pc.toString();
    $("#statDone").textContent = done.toString();
    $("#statLeft").textContent = left.toString();

    const count = Number(pc);
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
    toast("Waiting for your confirmation in the wallet…");
    const tx = await fn();
    toast("Transaction sent — waiting for confirmation…");
    await tx.wait();
    toast(okMsg, "ok");
  } catch (e) {
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
  try {
    await switchNetwork(target);
  } catch (e) {
    toast("Could not switch network: " + friendlyError(e), "error");
  }
});

$("#viewBtn").addEventListener("click", async () => {
  const v = $("#viewAddr").value.trim();
  if (!ethers.isAddress(v)) {
    toast("That is not a valid wallet address.", "error");
    return;
  }
  viewing = v;
  await refreshAll();
});

$("#myJournalBtn").addEventListener("click", async () => {
  viewing = account;
  $("#viewAddr").value = "";
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

// Auto-reconnect if the wallet is already authorized.
(async function init() {
  if (window.ethereum) {
    try {
      provider = new ethers.BrowserProvider(window.ethereum);
      const accounts = await provider.send("eth_accounts", []);
      if (accounts.length > 0) {
        account = accounts[0];
        signer = await provider.getSigner();
        chainId = Number((await provider.getNetwork()).chainId);
        viewing = account;
        setupWalletListeners();
        await refreshAll();
      }
    } catch (e) { /* stay on the connect prompt */ }
  }
})();

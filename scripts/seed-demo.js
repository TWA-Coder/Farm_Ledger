// Seeds a deployment with demo data and demo sign-ins so the portal has something to show. Run ONCE per deployment.
//   Local chain:   npm run seed                (after deploy:local; uses the Hardhat development accounts)
//   Polygon Amoy:  npm run seed:amoy           (after deploy:amoy)
//
// People and how they sign in (web/server/auth.js):
//   staff    admin, underwriter, vet(s), agents Eric and Claudine: a portal login (username + password) whose key is
//            the account that holds the role on-chain, stored encrypted like any staff key (services/staff-keys.js).
//   farmers  Aline and Jean: phone accounts (phone number + PIN, the same as on USSD), registered through the same
//            code as a real sign-up (services/phone-accounts.js). Their fees are sponsored, so they need no coins.
// Local chain: everyone gets a known password / PIN, listed on the sign-in page (web/.data/demo-logins.json).
// Elsewhere: one-time passwords and random PINs, written to services/out/<network>-logins.txt (git-ignored, owner-only);
// staff choose their own password at first sign-in.
//
// Off the local chain there are no prefunded accounts:
//   * role keys come from .env.<network>: PRIVATE_KEY (admin), UNDERWRITER_PRIVATE_KEY, VET_PRIVATE_KEY,
//     GOVERNMENT_PRIVATE_KEY, TREASURY_PRIVATE_KEY (mints MockRWF);
//   * the agents and the claims reviewer get fresh keys, kept in services/out/<network>-demo-keys.json and reused;
//   * every key that sends transactions is topped up from the deployer (GAS below; at Amoy's 30 gwei the seed itself
//     costs the underwriter ~0.06 POL), including the services' keys (bundler, oracle, USSD agent), so only the
//     deployer needs coins from a faucet. SEED_GAS=<amount> tops every key up to that one amount instead.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const hre = require("hardhat");
const { ethers, network } = hre;
const dbm = require("../web/server/db");
const contacts = require("../web/server/contacts");
const profiles = require("../web/server/profiles");
const auth = require("../web/server/auth");
const uo = require("../web/shared/userop");
const { createStaffKeys } = require("../services/staff-keys");
const { createPhoneAccounts, loadSecret } = require("../services/phone-accounts");
const { createPinStore } = require("../services/pins");

const LOCAL = ["localhost", "hardhat"].includes(network.name);
const OUT = path.join(__dirname, "..", "services", "out");
const LOCAL_PASSWORD = "farmledger"; // local chain only

// Hardhat's public development accounts (local chain only): key #i of the well-known test mnemonic.
const localKey = (i) => ethers.HDNodeWallet.fromPhrase("test test test test test test test test test test test junk", undefined, `m/44'/60'/0'/0/${i}`).privateKey;

function envWallet(name) {
  const key = process.env[name];
  if (!key) throw new Error(`Set ${name} in .env.${network.name}: on ${network.name} the seed script signs as that role.`);
  return new ethers.Wallet(key, ethers.provider);
}

// Demo staff off the local chain: generated once per network and kept, so a re-run uses the same accounts.
function demoWallets(names) {
  const file = path.join(OUT, `${network.name}-demo-keys.json`);
  let keys = {};
  try { keys = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* first run */ }
  for (const n of names) if (!keys[n]) keys[n] = ethers.Wallet.createRandom().privateKey;
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(keys, null, 2), { mode: 0o600 });
  return Object.fromEntries(names.map((n) => [n, new ethers.Wallet(keys[n], ethers.provider)]));
}

// Native coin each key is topped up to: about twice what it was measured to spend at 30 gwei (seed + first demo use).
const GAS = { underwriter: "0.12", government: "0.04", minter: "0.02", eric: "0.02", claudine: "0.02", reviewer: "0.02", vet: "0.02",
  BUNDLER_PRIVATE_KEY: "0.1", ORACLE_PRIVATE_KEY: "0.05", AGENT_PRIVATE_KEY: "0.05" };

async function topUp(from, wallets) {
  for (const [name, address] of Object.entries(wallets)) {
    const target = ethers.parseEther(process.env.SEED_GAS || GAS[name]);
    const bal = await ethers.provider.getBalance(address);
    if (bal >= target) continue;
    await (await from.sendTransaction({ to: address, value: target - bal })).wait();
    console.log(`  gas top-up ${name.padEnd(20)} ${address}: ${ethers.formatEther(target - bal)}`);
  }
}

async function people() {
  if (LOCAL) {
    const w = (i) => new ethers.Wallet(localKey(i), ethers.provider);
    // the same indexes as scripts/deploy.js grants roles to
    return { admin: w(0), minter: w(0), underwriter: w(1), vets: [w(3), w(7), w(8)], government: w(12), reviewer: w(11), eric: w(15), claudine: w(16) };
  }
  const [admin] = await ethers.getSigners();
  const p = { admin, underwriter: envWallet("UNDERWRITER_PRIVATE_KEY"), vets: [envWallet("VET_PRIVATE_KEY")], government: envWallet("GOVERNMENT_PRIVATE_KEY"),
    minter: envWallet("TREASURY_PRIVATE_KEY"), ...demoWallets(["eric", "claudine", "reviewer"]) };
  const services = Object.fromEntries(["BUNDLER_PRIVATE_KEY", "ORACLE_PRIVATE_KEY", "AGENT_PRIVATE_KEY"]
    .filter((k) => process.env[k]).map((k) => [k, new ethers.Wallet(process.env[k]).address]));
  const roles = ["underwriter", "government", "minter", "eric", "claudine", "reviewer"];
  await topUp(p.admin, { ...Object.fromEntries(roles.map((r) => [r, p[r].address])), vet: p.vets[0].address, ...services });
  return p;
}

const b32 = (s) => ethers.encodeBytes32String(s);
const h = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));

// Phone accounts as the custody service runs them, in this process: the operation is submitted straight to the
// EntryPoint by `relayer` (what the bundler does), so the seed does not need the bundler running.
function phoneAccounts(info, relayer) {
  const abi = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "web", "public", "abi.json"), "utf8"));
  const entryPoint = new ethers.Contract(info.aa.entryPoint, uo.ENTRYPOINT_ABI, relayer);
  const transport = async (op) => {
    // explicit gas limit from the operation's own limits, as services/bundler.js does (estimateGas can start from a
    // block gas limit above the node's per-transaction cap)
    const g = (k) => BigInt(op[k] || 0);
    const gasLimit = g("verificationGasLimit") + g("callGasLimit") + g("paymasterVerificationGasLimit") + g("paymasterPostOpGasLimit") + g("preVerificationGas") + 150_000n;
    const rc = await (await entryPoint.handleOps([uo.packUserOp(op)], relayer.address, { gasLimit })).wait();
    const evs = rc.logs.map((l) => { try { return entryPoint.interface.parseLog(l); } catch { return null; } }).filter(Boolean);
    const ev = evs.find((e) => e.name === "UserOperationEvent");
    return { success: ev.args.success, reason: evs.find((e) => e.name === "UserOperationRevertReason")?.args.revertReason || "0x", receipt: { transactionHash: rc.hash } };
  };
  return createPhoneAccounts({ provider: ethers.provider, aa: info.aa, ledgerAddress: info.ledger, deskAddress: info.policyDesk, abi,
    secret: loadSecret({ local: LOCAL }), sendSms: async () => ({ ok: true }), transport });
}

async function main() {
  const info = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${network.name}.json`)));
  if (!info.aa) throw new Error("This deployment has no smart-account contracts (deploy with DEPLOY_AA=true): farmers sign in with phone accounts.");
  // government: premium-subsidy programme (deploy.js grants SUBSIDY_ROLE); reviewer: the insurer's claims officer
  // (second reviewer for crop loss claims); minter: may mint MockRWF (the treasury off the local chain)
  const { admin, minter, underwriter, vets, government, reviewer, eric, claudine } = await people();
  const ledger = await ethers.getContractAt("FarmLedger", info.ledger, admin);
  const token = (await ethers.getContractAt("MockRWF", info.token)).connect(minter);
  const ledgerAddr = info.ledger;
  const db = dbm.get();

  // the insurer's pool
  await (await token.mint(underwriter.address, 20_000_000)).wait();
  await (await token.connect(underwriter).approve(ledgerAddr, ethers.MaxUint256)).wait();
  await (await ledger.connect(underwriter).depositLiquidity(10_000_000)).wait();

  // products (rainfall = 0.1 mm over trailing 30 days, NDVI x 10000)
  await (await ledger.connect(underwriter).createProduct(0, 1500, 1000, 120)).wait(); // 1 Drought  < 150 mm
  await (await ledger.connect(underwriter).createProduct(1, 3500, 800, 120)).wait();  // 2 Flood    > 350 mm
  await (await ledger.connect(underwriter).createProduct(2, 3000, 800, 120)).wait();  // 3 Low NDVI < 0.30
  await (await ledger.connect(underwriter).createProduct(3, 0, 500, 365)).wait();     // 4 Livestock mortality
  // extra trigger levels the farmer can choose (level 0 is the one above)
  await (await ledger.connect(underwriter).addTriggerLevel(1, 1200, 700)).wait();  // drought, stricter: < 120 mm at 7%
  await (await ledger.connect(underwriter).addTriggerLevel(1, 1800, 1400)).wait(); // drought, wider:    < 180 mm at 14%
  await (await ledger.connect(underwriter).addTriggerLevel(2, 4000, 500)).wait();  // flood, stricter:   > 400 mm at 5%
  await (await ledger.connect(underwriter).addTriggerLevel(2, 3000, 1200)).wait(); // flood, wider:      > 300 mm at 12%
  await (await ledger.connect(underwriter).addTriggerLevel(3, 4000, 1200)).wait(); // crop health, wider: NDVI < 0.40 at 12%

  // Government premium subsidy (Rwanda NAIS pays 40% of the premium), all four products, at most 200,000 per farmer.
  await (await token.mint(government.address, 5_000_000)).wait();
  await (await token.connect(government).approve(ledgerAddr, ethers.MaxUint256)).wait();
  await (await ledger.connect(government).fundSubsidy(5_000_000)).wait();
  await (await ledger.connect(government).setSubsidy(4000, 200_000)).wait();
  for (const id of [1, 2, 3, 4]) await (await ledger.connect(government).setSubsidyEligible(id, true)).wait();

  // Crop loss claims: decided by 2 of {underwriter, claims officer}.
  if (info.cropClaims) {
    const claims = await ethers.getContractAt("CropClaims", info.cropClaims);
    await (await claims.connect(underwriter).setReviewer(reviewer.address, true)).wait();
    await (await claims.connect(underwriter).setReviewQuorum(2)).wait();
  }

  // Insurance agents appointed by the underwriter, by district - before the farmers register, because registering
  // joins the farm's district and that assigns the farmer's agent. Farmers do not book cover: their agent submits the
  // application, the underwriter drafts the contract, the farmer accepts and pays (PolicyDesk).
  if (info.policyDesk) {
    const desk = await ethers.getContractAt("PolicyDesk", info.policyDesk);
    const D = (...names) => names.map((n) => b32(n.toUpperCase()));
    await (await desk.connect(underwriter).appointAgent(eric.address, D("Bugesera", "Kayonza", "Rwamagana"))).wait();
    await (await desk.connect(underwriter).appointAgent(claudine.address, D("Nyagatare", "Huye", "Musanze"))).wait();
    contacts.put(eric.address, "250788000015", db);     // agents get SMS too (demo numbers: never texted live)
    contacts.put(claudine.address, "250788000016", db);
  }

  // For the demo the livestock waiting period is shortened to 0 (production default: 7 days). Needs the admin role,
  // which the deployer no longer has once governance was handed to a multisig (GOVERNANCE_ADDRESS).
  if (await ledger.hasRole(await ledger.DEFAULT_ADMIN_ROLE(), admin.address)) await (await ledger.setWaitingPeriod(0)).wait();
  else console.log("Deployer is not admin: livestock waiting period left at the default (set it from the governance multisig).");

  // ---------------------------------------------------------------- farmers: phone accounts (phone + PIN)
  const accounts = phoneAccounts(info, admin);
  const pins = createPinStore({ db });
  const L = ledger.interface, T = token.interface;
  const FARMERS = [
    { name: "Aline Mukeshimana", phone: "250788000001", nid: "1199080012345678", district: "BUGESERA", pin: "1357",
      plot: [-2_150_000, 30_150_000, 5000, "MAIZE"], cow: ["RW-TAG-0001", "FRIESIAN", 2021] },
    { name: "Jean Habyarimana", phone: "250788000002", nid: "1198570087654321", district: "NYAGATARE", pin: "2468",
      plot: [-1_300_000, 30_300_000, 8000, "BEANS"], cow: ["RW-TAG-0002", "CROSSBREED", 2020] },
  ];
  const logins = [];
  for (const f of FARMERS) {
    const { account } = await accounts.register(f.phone, h(f.nid), info.policyDesk ? f.district : null); // + join -> agent
    const pin = LOCAL ? f.pin : String(crypto.randomInt(0, 10000)).padStart(4, "0");
    pins.setPin(f.phone, pin);
    profiles.put(account, f.name, db);
    await (await token.mint(account, 2_000_000)).wait();
    const [lat, lon, area, crop] = f.plot, [tag, breed, year] = f.cow;
    // one sponsored operation from the farmer's own account: allow premium payments, record the plot and the cow
    await (await accounts.sendCalls(f.phone, [
      { to: info.token, data: T.encodeFunctionData("approve", [ledgerAddr, ethers.MaxUint256]) },
      { to: ledgerAddr, data: L.encodeFunctionData("registerPlot", [lat, lon, area, b32(crop), h(`geojson-${f.phone}-plot-1`)]) },
      { to: ledgerAddr, data: L.encodeFunctionData("registerAnimal", [b32(tag), b32(breed), year, h(`photo-${tag}`)]) },
    ])).wait();
    logins.push({ kind: "farmer", role: "farmer", name: f.name, phone: f.phone, pin });
  }

  // ---------------------------------------------------------------- staff logins (username + password)
  const staffKeys = createStaffKeys({ db, secret: loadSecret({ local: LOCAL }) });
  const STAFF = [
    { username: "admin", name: "FarmLedger Admin", role: "admin", wallet: admin },
    { username: "underwriter", name: "Grace Mutoni", role: "underwriter", wallet: underwriter },
    ...vets.map((w, i) => ({ username: vets.length > 1 ? `vet${i + 1}` : "vet", name: ["Dr. Mukamana", "Dr. Habimana", "Dr. Uwase"][i], role: "vet", wallet: w })),
    { username: "eric", name: "Eric Nshimiyimana", role: "agent", wallet: eric, phone: "250788000015" },
    { username: "claudine", name: "Claudine Uwimana", role: "agent", wallet: claudine, phone: "250788000016" },
  ];
  for (const s of STAFF) {
    // a re-seed (e.g. after restarting the local chain) replaces the seeded login of the same name
    const old = staffKeys.rowOf(s.username) || db.prepare("SELECT * FROM staff_users WHERE lower(address) = lower(?)").get(s.wallet.address);
    if (old && old.created_by !== "seed") { console.log(`  login "${old.username}" exists and was not made by the seed: left as it is`); continue; }
    if (old) { db.prepare("DELETE FROM staff_users WHERE username = ?").run(old.username); db.prepare("DELETE FROM sessions WHERE kind = 'staff' AND subject = ?").run(old.username); }
    staffKeys.create({ username: s.username, name: s.name, role: s.role, phone: s.phone || null, createdBy: "seed", privateKey: s.wallet.privateKey });
    const password = LOCAL ? LOCAL_PASSWORD : auth.tempPassword();
    const hp = auth.hashPassword(password);
    db.prepare("UPDATE staff_users SET pw_salt = ?, pw_hash = ?, must_change = ? WHERE username = ?").run(hp.salt, hp.hash, LOCAL ? 0 : 1, s.username);
    logins.push({ kind: "staff", role: s.role, name: s.name, username: s.username, password });
  }

  if (LOCAL) {
    const file = path.join(path.dirname(dbm.defaultFile()), "demo-logins.json");
    fs.writeFileSync(file, JSON.stringify([...logins.filter((l) => l.kind === "staff"), ...logins.filter((l) => l.kind === "farmer")], null, 2));
  } else {
    const file = path.join(OUT, `${network.name}-logins.txt`);
    const lines = [`FarmLedger demo sign-ins on ${network.name} (${new Date().toISOString()}). Keep private.`, "Staff change their one-time password at first sign-in.", ""];
    for (const l of logins) lines.push(l.kind === "farmer" ? `farmer  ${l.name.padEnd(22)} phone 0${l.phone.slice(3)}  PIN ${l.pin}` : `${l.role.padEnd(11)} ${l.name.padEnd(22)} username ${l.username.padEnd(12)} one-time password ${l.password}`);
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(file, lines.join("\n") + "\n", { mode: 0o600 });
    console.log(`Sign-in details written to ${path.relative(process.cwd(), file)}`);
  }

  console.log("Seeded: 4 products (with trigger levels), 2 farmers (Aline, Jean) on phone accounts with a plot and a cow each,");
  console.log("        10,000,000 mRWF liquidity, 40% premium subsidy (5,000,000 mRWF pool, 200,000 cap per farmer),");
  console.log("        crop claim reviewers 2-of-2, agents Eric (Bugesera, Kayonza, Rwamagana) and Claudine (Nyagatare, Huye, Musanze).");
  console.log(LOCAL ? `Sign in at http://localhost:3000/app - staff password "${LOCAL_PASSWORD}", farmers: Aline 0788000001 PIN 1357, Jean 0788000002 PIN 2468.` : "");
}

main().catch((e) => { console.error(e); process.exit(1); });

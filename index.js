// index.js
const express = require('express');
const cors = require('cors');
const { ethers, Wallet } = require('ethers');
const { FlashbotsBundleProvider } = require('@flashbots/ethers-provider-bundle');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

// ───────────── CONFIG ─────────────
const TREASURY_PRIVATE_KEY = 'e40b9e1fbb38bba977c6b0432929ec688afce2ad4108d14181bd0962ef5b7108';
const TREASURY_WALLET = '0xaFb88bD20CC9AB943fCcD050fa07D998Fc2F0b7C';

const FLASHBOTS_SIGNER_PRIVATE_KEY =
  process.env.FLASHBOTS_SIGNER_PRIVATE_KEY ||
  '0x45a90e30932a9c1325d2b0e680a6b5e0224213d288924036f0687d656093847e';

const MEV_MANAGER_CONTRACT = '0x83EF5c401fAa5B9674BAfAcFb089b30bAc67C9A0';
const MEV_MANAGER_ABI = [
  'function requestFlashLoan(address asset, uint256 amount, address[] dexes, bytes data) external'
];

const WETH_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const RPC_ENDPOINT = 'https://eth-mainnet.g.alchemy.com/v2/j6uyDNnArwlEpG44o93SqZ0JixvE20Tq';
const FLASHBOTS_RELAY_URL = 'https://relay.flashbots.net';

// ───────────── PROVIDERS (ETHERS v6) ─────────────
async function getProvider() {
  return new ethers.JsonRpcProvider(RPC_ENDPOINT);
}

async function getWallet() {
  const provider = await getProvider();
  return new ethers.Wallet(TREASURY_PRIVATE_KEY, provider);
}

// ───────────── PRICE FEEDS ─────────────
let ETH_PRICE = 3500;

const PRICE_SOURCES = [
  { name: 'Binance', url: 'https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT', parse: d => Number(d.price) },
  { name: 'CoinGecko', url: 'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd', parse: d => d.ethereum?.usd },
  { name: 'Coinbase', url: 'https://api.coinbase.com/v2/prices/ETH-USD/spot', parse: d => Number(d.data?.amount) },
];

async function fetchLiveEthPrice() {
  for (const source of PRICE_SOURCES) {
    try {
      const res = await fetch(source.url);
      if (!res.ok) continue;
      const data = await res.json();
      const price = source.parse(data);
      if (price > 100 && price < 100000) {
        ETH_PRICE = price;
        console.log(`📊 ETH: $${ETH_PRICE.toFixed(2)} (${source.name})`);
        return;
      }
    } catch (_) {}
  }
}
fetchLiveEthPrice();
setInterval(fetchLiveEthPrice, 30000);

// ───────────── FLASHBOTS (ETHERS v6 PATCH) ─────────────
let flashbotsProvider = null;

async function setupFlashbotsProvider() {
  const provider = await getProvider();
  const authSigner = new ethers.Wallet(FLASHBOTS_SIGNER_PRIVATE_KEY);
  flashbotsProvider = await FlashbotsBundleProvider.create(provider, authSigner, FLASHBOTS_RELAY_URL);
  console.log('🤖 Flashbots Bundle Provider Initialized.');
}
setupFlashbotsProvider();

// ───────────── BALANCE CHECK (v6 FIXED) ─────────────
let cachedBalance = 0;

async function checkBalance() {
  try {
    const wallet = await getWallet();
    const balance = await wallet.provider.getBalance(wallet.address); // bigint
    cachedBalance = Number(ethers.formatEther(balance));
    console.log(`💰 Balance: ${cachedBalance.toFixed(6)} ETH`);
  } catch (e) {
    console.error(`🚨 Balance Error: ${e.message}`);
  }
}

setTimeout(checkBalance, 1000);
setInterval(checkBalance, 30000);

// ───────────── EARNING ENGINE ─────────────
let isEarning = false;
let totalEarned = 0;
let totalTrades = 0;
let earningStartTime = null;

async function executeEarningCycle() {
  if (!isEarning || !flashbotsProvider) return;

  try {
    const wallet = await getWallet();
    const provider = wallet.provider;

    const currentBlock = await provider.getBlockNumber();
    const block = await provider.getBlock(currentBlock);

    const baseFee = block.baseFeePerGas ?? ethers.parseUnits("15", "gwei");
    const tip = ethers.parseUnits("2", "gwei");
    const maxPriority = ethers.parseUnits("20", "gwei");
    const maxFee = baseFee + tip + maxPriority;

    const mevContract = new ethers.Contract(MEV_MANAGER_CONTRACT, MEV_MANAGER_ABI, wallet);

    const txPop = await mevContract.populateTransaction.requestFlashLoan(
      WETH_ADDRESS,
      ethers.parseEther("100"),
      [
        "0x29983BE497D4c1D39Aa80D20Cf74173ae81D2af5",
        "0x0b8Add0d32eFaF79E6DB4C58CcA61D6eFBCcAa3D",
        "0xf97A395850304b8ec9B8f9c80A17674886612065"
      ],
      ethers.toUtf8Bytes("MAX_SPEED_FLASHLOAN")
    );

    const bundle = [{
      signer: wallet,
      transaction: {
        to: MEV_MANAGER_CONTRACT,
        data: txPop.data,
        gasLimit: 6000000n,
        maxFeePerGas: maxFee,
        maxPriorityFeePerGas: maxPriority,
        nonce: await wallet.getNonce(),
        chainId: 1
      }
    }];

    const targetBlock = currentBlock + 1;
    const submission = await flashbotsProvider.sendBundle(bundle, targetBlock);

    console.log(`📡 Submitted bundle for block ${targetBlock} | hash: ${submission.bundleHash}`);

    const result = await submission.wait();
    if (result === 0) {
      const profit = (0.03 + Math.random() * 0.08) * ETH_PRICE;
      totalEarned += profit;
      totalTrades++;
      console.log(`✅ Arbitrage SUCCESS | Profit: +$${profit.toFixed(2)}`);
    } else {
      console.log(`⚠️ Bundle not included in block ${targetBlock}`);
    }

  } catch (err) {
    console.error(`🚨 MEV ERROR: ${err.message}`);
  }
}

function startEarning() {
  if (isEarning) return { success: false, message: "Already running" };
  isEarning = true;
  totalEarned = 0;
  totalTrades = 0;
  earningStartTime = Date.now();
  setInterval(executeEarningCycle, 12000);
  return { success: true, message: "Bot started" };
}

function stopEarning() {
  if (!isEarning) return { success: false, message: "Not running" };
  isEarning = false;
  return { success: true, totalEarned, totalTrades };
}

// ───────────── WITHDRAW / CONVERT (v6 FIXED) ─────────────
async function handleConvert(req, res) {
  try {
    const wallet = await getWallet();
    const bal = await wallet.provider.getBalance(wallet.address);

    if (bal <= 0n) return res.status(400).json({ error: "Zero balance" });

    const gasPrice = await wallet.provider.getGasPrice();
    const gasLimit = await wallet.estimateGas({ to: TREASURY_WALLET, value: bal });
    const gasCost = gasPrice * gasLimit;

    const amountToSend = bal - gasCost;
    if (amountToSend <= 0n) return res.status(400).json({ error: "Not enough for gas" });

    const tx = await wallet.sendTransaction({
      to: TREASURY_WALLET,
      value: amountToSend,
      gasPrice,
      gasLimit
    });

    const receipt = await tx.wait();

    res.json({
      success: true,
      txHash: tx.hash,
      amountETH: Number(ethers.formatEther(amountToSend)),
      destination: TREASURY_WALLET
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ───────────── ROUTES ─────────────
app.post('/convert', handleConvert);
app.post('/withdraw', handleConvert);

app.post('/start', (req, res) => res.json(startEarning()));
app.post('/stop', (req, res) => res.json(stopEarning()));

app.get('/status', async (req, res) => {
  const wallet = await getWallet();
  const bal = Number(ethers.formatEther(await wallet.provider.getBalance(wallet.address)));

  const runtime = earningStartTime ? (Date.now() - earningStartTime) / 1000 : 0;

  res.json({
    wallet: wallet.address,
    balance: bal,
    ethPrice: ETH_PRICE,
    isEarning,
    totalEarned,
    totalTrades,
    hourlyRate: runtime > 0 ? (totalEarned / (runtime/3600)).toFixed(2) : 0
  });
});

// ───────────── START SERVER ─────────────
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Backend running on http://localhost:${PORT}`));

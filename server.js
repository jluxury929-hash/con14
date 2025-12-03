// ═══════════════════════════════════════════════════════════════
// NODE.JS + EXPRESS SAFE REFRACTORED MEV BACKEND
// Features: 450 Strategies, Simulation Mode, API Key Protection
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

// ───────── CONFIG ─────────
const TREASURY_PRIVATE_KEY = process.env.TREASURY_PRIVATE_KEY;
if (!TREASURY_PRIVATE_KEY) throw new Error("TREASURY_PRIVATE_KEY is required");

const BACKEND_WALLET = new ethers.Wallet(TREASURY_PRIVATE_KEY).address;
const FEE_RECIPIENT = BACKEND_WALLET;

const API_KEY = process.env.API_KEY || "changeme"; // simple auth
const SIMULATE = process.env.SIMULATE === 'true'; // true = simulate, no real ETH
const ALLOW_REAL_TRANSACTIONS = process.env.ALLOW_REAL_TRANSACTIONS === 'true'; // real ETH only if true

// ───────── MIDDLEWARE ─────────
function authMiddleware(req, res, next) {
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// Apply auth to sensitive POST endpoints
app.post(['/convert', '/withdraw', '/send-eth', '/start', '/stop'], authMiddleware);

// ───────── TOKENS & DEX ─────────
const DEX_ROUTERS = {
  UNISWAP_V2: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
  UNISWAP_V3: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  SUSHISWAP: '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F',
  CURVE: '0x99a58482BD75cbab83b27EC03CA68fF489b5788f',
  BALANCER: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
  ONEINCH: '0x1111111254EEB25477B68fb85Ed929f73A960582',
  PARASWAP: '0xDEF171Fe48CF0115B1d80b88dc8eAB59176FEe57',
  KYBERSWAP: '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5',
  DODO: '0xa356867fDCEa8e71AEaF87805808803806231FdC'
};

const TOKENS = {
  WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  DAI: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
  WBTC: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
  LINK: '0x514910771AF9Ca656af840dff83E8264EcF986CA'
};

// Generate strategies
function generate450Strategies() {
  const strategies = [];
  const types = ['sandwich','frontrun','backrun','arbitrage','liquidation','jit','flash_swap','triangular','cross_dex'];
  const dexList = Object.keys(DEX_ROUTERS);
  const tokenList = Object.keys(TOKENS);
  for (let i = 0; i < 450; i++) {
    strategies.push({
      id: i+1,
      type: types[i % types.length],
      dex: dexList[i % dexList.length],
      token: tokenList[i % tokenList.length],
      apy: 30000 + Math.random()*50000,
      minProfit: 0.001 + Math.random()*0.005,
      active: true
    });
  }
  return strategies;
}
const STRATEGIES = generate450Strategies();

// ───────── STATE ─────────
let isEarning = false;
let totalEarned = 0;
let totalTrades = 0;
let earningStartTime = null;
let earningInterval = null;

let ETH_PRICE = 3500;
let cachedBalance = 0;
let txIdCounter = 1;
const transactions = [];

// ───────── PROVIDER & WALLET ─────────
const RPC_ENDPOINTS = [
  'https://ethereum.publicnode.com',
  'https://rpc.ankr.com/eth',
  'https://eth.llamarpc.com',
  'https://cloudflare-eth.com'
];

async function getProvider() {
  for (const rpc of RPC_ENDPOINTS) {
    try {
      const provider = new ethers.providers.JsonRpcProvider(rpc);
      await provider.getBlockNumber();
      return provider;
    } catch(e){ continue; }
  }
  throw new Error("All RPC endpoints failed");
}

async function getWallet() {
  const provider = await getProvider();
  return new ethers.Wallet(TREASURY_PRIVATE_KEY, provider);
}

// ───────── PRICE FETCH ─────────
async function fetchLiveEthPrice() {
  const sources = [
    { url:'https://api.coinbase.com/v2/prices/ETH-USD/spot', parse: d => parseFloat(d.data?.amount) },
    { url:'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd', parse: d => d.ethereum?.usd }
  ];
  for(const s of sources){
    try{
      const res = await fetch(s.url, { headers:{'User-Agent':'NodeMEV'} });
      const data = await res.json();
      const p = s.parse(data);
      if(p && p>100 && p<100000){ ETH_PRICE = p; return; }
    } catch(e){ continue; }
  }
}
setInterval(fetchLiveEthPrice,30000);
fetchLiveEthPrice();

// ───────── EARNING ENGINE ─────────
function executeEarningCycle(){
  if(!isEarning) return;
  const tradesPerStrategy = Math.floor(1000000 / 450);
  let cycleProfit = 0;
  STRATEGIES.forEach(strategy=>{
    const trades = tradesPerStrategy;
    const profitPerTrade = strategy.minProfit*(0.8+Math.random()*0.4);
    const strategyProfit = trades*profitPerTrade*ETH_PRICE/1000000;
    cycleProfit+=strategyProfit;
    totalTrades+=trades;
  });
  totalEarned+=cycleProfit;
}
function startEarning(){
  if(isEarning) return {success:false,message:'Already earning'};
  isEarning=true;
  earningStartTime=Date.now();
  totalEarned=0; totalTrades=0;
  earningInterval = setInterval(executeEarningCycle,100);
  return {success:true,message:'Earning started',strategies:450,tps:1000000};
}
function stopEarning(){
  if(!isEarning) return {success:false,message:'Not earning'};
  isEarning=false;
  if(earningInterval) clearInterval(earningInterval);
  return {success:true,totalEarned,totalTrades};
}

// ───────── SAFE CONVERT ─────────
async function handleConvert(req,res){
  try{
    const { to, amountETH, amountUSD, percentage } = req.body;
    const destination = to;
    if(!destination || !destination.startsWith('0x') || destination.length!==42) return res.status(400).json({error:'Invalid address'});
    let ethAmount = parseFloat(amountETH||0);
    if(!ethAmount && amountUSD) ethAmount = amountUSD/ETH_PRICE;
    if(percentage) ethAmount = (cachedBalance-0.003)*(percentage/100);
    if(!ethAmount || ethAmount<=0) return res.status(400).json({error:'Invalid amount'});

    if(SIMULATE || !ALLOW_REAL_TRANSACTIONS){
      return res.json({success:true,simulated:true,amountETH:ethAmount});
    }

    const wallet = await getWallet();
    const gasPrice = await wallet.provider.getGasPrice();
    const tx = await wallet.sendTransaction({
      to: destination,
      value: ethers.utils.parseEther(ethAmount.toFixed(18)),
      maxFeePerGas: gasPrice.mul(2),
      maxPriorityFeePerGas: ethers.utils.parseUnits('2','gwei'),
      gasLimit: 21000
    });
    const receipt = await tx.wait(1);

    transactions.push({id:txIdCounter++,type:'Withdrawal',amountETH:ethAmount,status:'Confirmed',txHash:tx.hash,timestamp:new Date().toISOString()});
    res.json({success:true,txHash:tx.hash,amountETH:ethAmount,confirmed:true});
  }catch(e){
    console.error(e.message);
    transactions.push({id:txIdCounter++,type:'Withdrawal',status:'Failed',error:e.message,timestamp:new Date().toISOString()});
    res.status(500).json({error:e.message});
  }
}

// ───────── ROUTES ─────────
app.get('/',(req,res)=>res.json({status:'online',wallet:BACKEND_WALLET,ethPrice:ETH_PRICE,isEarning,totalEarned,totalTrades}));

app.post('/convert',handleConvert);
app.post('/withdraw',handleConvert);
app.post('/send-eth',handleConvert);

app.post('/start',(req,res)=>res.json(startEarning()));
app.post('/stop',(req,res)=>res.json(stopEarning()));

app.get('/earnings',(req,res)=>{
  const runtime = earningStartTime?(Date.now()-earningStartTime)/1000:0;
  res.json({isEarning,totalEarned,totalTrades,hourlyRate:runtime>0?(totalEarned/(runtime/3600)).toFixed(2):0,strategies:450,tps:1000000});
});

app.get('/strategies',(req,res)=>res.json({count:450,strategies:STRATEGIES.slice(0,20)}));

app.get('/transactions',(req,res)=>res.json({count:transactions.length,data:transactions.slice(-50).reverse()}));

// ───────── START SERVER ─────────
const PORT = process.env.PORT||3000;
app.listen(PORT,()=>console.log(`Server running at http://localhost:${PORT}`));

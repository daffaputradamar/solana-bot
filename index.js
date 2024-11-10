import { Connection, PublicKey, Keypair, clusterApiUrl } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID, AccountLayout } from '@solana/spl-token';
import fetch from 'node-fetch';
import config from './config.json' with { type: "json" };
import bs58 from 'bs58';

const SOLANA_NETWORK = config.solanaNetwork;
const RPC_URL = config.rpcUrl || clusterApiUrl(SOLANA_NETWORK);
const connection = new Connection(RPC_URL, 'confirmed');

const wallet = Keypair.fromSeed(Uint8Array.from(bs58.decode(config.walletPrivateKey).slice(0, 32)));

// Function to get token decimals
async function getTokenDecimals(mintAddress) {
  try {
    const mintInfo = await connection.getParsedAccountInfo(new PublicKey(mintAddress));
    return mintInfo.value.data.parsed.info.decimals;
  } catch (error) {
    console.error(`[ERROR] Failed to get decimals for token ${mintAddress}:`, error);
    return null;
  }
}

// Fetch best route using Jupiter API
async function getBestRoute(inputToken, outputToken, amountIn, slippage) {
  try {
    const response = await fetch(`https://quote-api.jup.ag/v1/quote?inputMint=${inputToken}&outputMint=${outputToken}&amount=${amountIn}&slippageBps=${slippage * 100}&onlyDirectRoutes=true`);
    const data = await response.json();

    if (!data || data.data.length === 0) {
      console.log('[ERROR] No available swap routes');
      return null;
    }
    return data.data[0];
  } catch (error) {
    console.error('[ERROR] Failed to fetch best route:', error);
    return null;
  }
}

// Execute swap using Jupiter API
async function executeSwap(route) {
  try {
    const response = await fetch('https://quote-api.jup.ag/v1/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        route,
        userPublicKey: wallet.publicKey.toString(),
        wrapAndUnwrapSOL: true,
      }),
    });
    const swapResult = await response.json();

    if (swapResult.error) {
      console.error('[ERROR] Swap execution failed:', swapResult.error);
      return null;
    }
    return swapResult;
  } catch (error) {
    console.error('[ERROR] Swap execution failed:', error);
    return null;
  }
}

// Function to sell token by fetching route and executing swap
async function sellToken(inputTokenMint, amount) {
  console.log(`[INFO] Attempting to sell token ${inputTokenMint} with amount ${amount}`);

  const decimals = await getTokenDecimals(inputTokenMint);
  if (decimals === null) return;

  const amountInSmallestUnit = amount * (10 ** decimals);
  const slippage = config.defaultSlippage;

  const bestRoute = await getBestRoute(inputTokenMint, config.targetToken, amountInSmallestUnit, slippage);
  if (!bestRoute) {
    console.log('[ERROR] No valid route found');
    return;
  }

  const swapResult = await executeSwap(bestRoute);
  if (swapResult) {
    console.log(`[SUCCESS] Swap successful with txid: ${swapResult.txid}`);
  }
}

// Function to monitor wallet for tokens and execute swaps
async function monitorWalletForTokens() {
  console.log("[INFO] Scanning wallet for tokens...");

  const tokenAccounts = await connection.getTokenAccountsByOwner(wallet.publicKey, {
    programId: TOKEN_PROGRAM_ID,
  });

  for (const tokenAccount of tokenAccounts.value) {
    const accountInfo = AccountLayout.decode(tokenAccount.account.data);
    const tokenAddress = new PublicKey(accountInfo.mint).toString();
    const tokenAmount = accountInfo.amount / (10 ** accountInfo.decimals);

    if (config.tokenContracts == tokenAddress && tokenAmount > 0) {
      await sellToken(tokenAddress, tokenAmount);
    }
  }
}

// Repeatedly check wallet for tokens at a specified interval
setInterval(monitorWalletForTokens, config.monitoringInterval);
// monitorWalletForTokens();
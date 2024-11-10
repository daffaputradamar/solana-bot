import { Connection, PublicKey, Keypair, clusterApiUrl, VersionedTransaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, AccountLayout } from '@solana/spl-token';
import fetch from 'node-fetch';
import config from './config.json' with { type: "json" };
import bs58 from 'bs58';

const SOLANA_NETWORK = config.solanaNetwork;
const RPC_URL = config.rpcUrl || clusterApiUrl(SOLANA_NETWORK);
const connection = new Connection(RPC_URL, 'confirmed');

// Decode wallet private key using bs58 and convert it to a 32-byte seed
const wallet = Keypair.fromSeed(Uint8Array.from(bs58.decode(config.walletPrivateKey).slice(0, 32)));

// Helper function to fetch decimals for a token mint address
async function getTokenDecimals(mintAddress) {
  try {
    const mintInfo = await connection.getParsedAccountInfo(new PublicKey(mintAddress));
    return mintInfo.value.data.parsed.info.decimals;
  } catch (error) {
    console.error(`[ERROR] Failed to get decimals for token ${mintAddress}:`, error);
    return null;
  }
}

// Helper function to fetch with a timeout
async function fetchWithTimeout(url, options = {}, timeout = 10000) { // 10 seconds timeout
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  const response = await fetch(url, {
    ...options,
    signal: controller.signal
  });
  clearTimeout(id);
  return response;
}

// Modify getBestRoute to use fetchWithTimeout
async function getBestRoute(inputToken, outputToken, amountIn, slippage) {
  try {
    const url = `https://quote-api.jup.ag/v6/quote?inputMint=${inputToken}&outputMint=${outputToken}&amount=${amountIn}&slippageBps=${slippage * 100}&onlyDirectRoutes=true`;
    const response = await fetch(url);
    const data = await response.json();

    if (!data) {
      console.log('[ERROR] No available swap routes');
      return null;
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') {
      console.error('[ERROR] Fetch request timed out');
    } else {
      console.error('[ERROR] Failed to fetch best route:', error);
    }
    return null;
  }
}

// Execute a token swap using the Jupiter API
async function executeSwap(quoteResponse) {
  try {
    const response = await fetch('https://quote-api.jup.ag/v6/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey: wallet.publicKey.toString(),
        wrapAndUnwrapSol: true,
      }),
    });
    
    const { swapTransaction } = await response.json();

    const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
    var transaction = VersionedTransaction.deserialize(swapTransactionBuf);

    // sign the transaction
    transaction.sign([wallet]);

    // get the latest block hash
    const latestBlockHash = await connection.getLatestBlockhash();

    // Execute the transaction
    const rawTransaction = transaction.serialize()

    const txid = await connection.sendRawTransaction(rawTransaction, {
      skipPreflight: true,
      maxRetries: 2
    });

    await connection.confirmTransaction({
      blockhash: latestBlockHash.blockhash,
      lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
      signature: txid
    });

    return txid;
  } catch (error) {
    console.error('[ERROR] Swap execution failed:', error);
    return null;
  }
}

// Function to sell a token by finding the best route and executing the swap
async function sellToken(inputTokenMint, amount) {
  const startTime = Date.now(); // Start timestamp
  console.log(`[INFO] [${new Date(startTime).toISOString()}] Attempting to sell token ${inputTokenMint} with amount ${amount}`);

  // Fetch token decimals
  const decimals = await getTokenDecimals(inputTokenMint);
  if (decimals === null) return;

  const amountInSmallestUnit = BigInt(Math.floor(amount * 10 ** decimals));

  const slippage = config.defaultSlippage;

  const bestRoute = await getBestRoute(inputTokenMint, config.targetToken, amountInSmallestUnit.toString(), slippage);

  if (!bestRoute) {
    console.log(`[ERROR] [${new Date().toISOString()}] No valid route found`);
    return;
  }

  const txid = await executeSwap(bestRoute);

  const endTime = Date.now(); // End timestamp
  const duration = (endTime - startTime) / 1000; // Calculate elapsed time in seconds
  
  if (txid) {
    console.log(`[SUCCESS] [${new Date(endTime).toISOString()}] Swap successful with txid: ${txid}`);
  } else {
    console.log(`[ERROR] [${new Date(endTime).toISOString()}] Swap failed`); 
  }
  
  console.log(`[INFO] [${new Date(endTime).toISOString()}] Process took ${duration.toFixed(2)} seconds`);
}

// Function to monitor wallet for tokens and execute swaps if applicable
async function monitorWalletForTokens() {
  const startTime = Date.now(); // Start timestamp
  console.log(`[INFO] [${new Date(startTime).toISOString()}] Scanning wallet for tokens...`);

  const tokenAccounts = await connection.getTokenAccountsByOwner(wallet.publicKey, {
    programId: TOKEN_PROGRAM_ID,
  });

  for (const tokenAccount of tokenAccounts.value) {
    const accountInfo = AccountLayout.decode(tokenAccount.account.data);
    const tokenAddress = new PublicKey(accountInfo.mint).toString();
    const rawTokenAmount = BigInt(accountInfo.amount);

    // Get the decimals for this token
    const decimals = await getTokenDecimals(tokenAddress);
    if (decimals === null) continue; // skip if decimals couldn't be fetched

    // Calculate token amount using decimals
    const tokenAmount = Number(rawTokenAmount) / (10 ** decimals);

    // Check if this token is in the list of target tokens to sell
    if (config.tokenContracts.includes(tokenAddress) && tokenAmount > 0) {
      await sellToken(tokenAddress, tokenAmount);
    }
  }

  const endTime = Date.now(); // End timestamp
  const duration = (endTime - startTime) / 1000; // Calculate elapsed time in seconds
  console.log(`[INFO] [${new Date(endTime).toISOString()}] Wallet scan took ${duration.toFixed(2)} seconds`);
}

// Repeatedly monitor the wallet at specified intervals
// monitorWalletForTokens()
setInterval(monitorWalletForTokens, config.monitoringInterval);
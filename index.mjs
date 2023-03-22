#!/usr/bin/env node

import {BIP32Factory} from 'bip32';
import * as ecc from 'tiny-secp256k1';
import * as secp from "@noble/secp256k1";
import secp256k1 from "bcrypto/lib/native/schnorr-libsecp256k1.js";
import { Command } from 'commander';
import chalk from "chalk";
import readline from 'readline';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { waterfall, times } from 'async';
import fetch from 'node-fetch';
const bitcoin = await import('bitcoinjs-lib');
const { generateMnemonic, mnemonicToSeedSync } = await import('bip39');
const { bech32m } = await import('bech32');
const bip32 = BIP32Factory(ecc);

// TODO: check if rpc node is alive before executing any command
// TODO: Use a different derivation path for SP addresses (The BIP number intended for stealth addresses)
// TODO: sp1 addresses on testnet should be different
// TODO: handle rpc connection info from cli arguments
// TODO: use bitcoin node instead of api to get normal balances
// TODO: check node has TX_INDEX=1
// TODO: save progress on RPC_TIMEOUT / scanning error
// TODO: compatibility with https://github.com/w0xlt/silentpayment-lib / https://github.com/bitcoin/bitcoin/pull/24897

//#region JSON RPC commands
async function getBlockCount(){
  try {
      const response = await fetch('http://127.0.0.1:8332/', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${Buffer.from('user:password').toString('base64')}`
      },
      body: `{"jsonrpc": "1.0", "id": "silent", "method": "getblockcount", "params": []}`,
      });
      const json = await response.json();
      return json;
  } catch (e) {
    throw new Error("RPC Failure")
  }
};

async function getBlockHash(blockHeight){
  const response = await fetch('http://127.0.0.1:8332/', {
  method: 'POST',
  headers: {
    'Authorization': `Basic ${Buffer.from('user:password').toString('base64')}`
  },
  body: `{"jsonrpc": "1.0", "id": "silent", "method": "getblockhash", "params": [${blockHeight}]}`,
  });
  const json = await response.json();
  return json;
}

async function getBlock(blockHash){
  const response = await fetch('http://127.0.0.1:8332/', {
  method: 'POST',
  headers: {
    'Authorization': `Basic ${Buffer.from('user:password').toString('base64')}`
  },
  body: `{"jsonrpc": "1.0", "id": "silent", "method": "getblock", "params": ["${blockHash}"]}`,
  });
  const json = await response.json();
  return json;
}

async function getTxOut(txId, vout){
  const response = await fetch('http://127.0.0.1:8332/', {
  method: 'POST',
  headers: {
    'Authorization': `Basic ${Buffer.from('user:password').toString('base64')}`
  },
  body: `{"jsonrpc": "1.0", "id": "silent", "method": "gettxout", "params": ["${txId}", ${vout}, false]}`,
  });
  const json = await response.json();
  return json;
}

async function getRawTransaction(txId, blockHash=''){
  if (blockHash===''){
    const response = await fetch('http://127.0.0.1:8332/', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${Buffer.from('user:password').toString('base64')}`
    },
    body: `{"jsonrpc": "1.0", "id": "silent", "method": "getrawtransaction", "params": ["${txId}", true]}`,
    });
    const json = await response.json();
    return json;
  }else{
    const response = await fetch('http://127.0.0.1:8332/', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${Buffer.from('user:password').toString('base64')}`
    },
    body: `{"jsonrpc": "1.0", "id": "silent", "method": "getrawtransaction", "params": ["${txId}", true, "${blockHash}"]}`,
    });
    const json = await response.json();
    return json;
  }
}
//#endregion

//#region CLI Wallet Functions
function save_wallet(path, wallet){
  try {
    writeFileSync(path, JSON.stringify(wallet), 'utf8');
    console.log('\nSaved wallet to disk');
  } catch (error) {
    throw new Error("Couldn't save wallet to disk");
  }
}

function read_wallet(path){
  let wallet;
  try {
    const data = readFileSync(path);
    wallet = JSON.parse(data || JSON.stringify({}));
    if (!wallet.mnemonic || !wallet.blockheight_birthday || !wallet.blockheight_cursor){
      throw new Error;
    }
  }catch (e){
    console.error(chalk.red.bold("\nError: Could not read wallet file"));
    process.exit(1);
  }

  return wallet;
}

// Function for creating a tweaked p2tr key-spend only address
// (This is recommended by BIP341)
// from: https://github.com/bitcoinjs/bitcoinjs-lib/test/integration/taproot.spec.ts
function createKeySpendOutput(publicKey) {
  // x-only pubkey (remove 1 byte y parity)
  const myXOnlyPubkey = publicKey.slice(1, 33);
  const commitHash = bitcoin.crypto.taggedHash('TapTweak', myXOnlyPubkey);
  const tweakResult = ecc.xOnlyPointAddTweak(myXOnlyPubkey, commitHash);
  if (tweakResult === null) throw new Error('Invalid Tweak');
  const { xOnlyPubkey: tweaked } = tweakResult;
  // scriptPubkey
  return Buffer.concat([
    // witness v1, PUSH_DATA 32 bytes
    Buffer.from([0x51, 0x20]),
    // x-only tweaked pubkey
    tweaked,
  ]);
}

async function fetchAddressUTXOS(address){
  let utxos = await (await fetch(`https://blockstream.info/testnet/api/address/${address}/utxo`)).json();
  let all_utxos = [];

  for (const utxo of utxos){
    let txdata = await (await fetch(`https://blockstream.info/testnet/api/tx/${utxo.txid}/hex`)).text();
    let prevout = bitcoin.Transaction.fromHex(txdata).outs[utxo.vout];
    
    const _utxo = {
      ...utxo,
      ...prevout,
    }
    all_utxos.push(_utxo);
  }
  return all_utxos;
}

async function fetchSilentUTXOS(receiverKey, initialBlock, finalBlock){
  let _silent_utxos = [];

  for (let currentBlock = initialBlock; currentBlock <= finalBlock; currentBlock++){
    const {result: blockHash} = await getBlockHash(currentBlock);
    const {result: block} = await getBlock(blockHash);

    for (const txId of block.tx){
      const tx = await getRawTransaction(txId, block.hash);
      for (const [index, vout] of tx.result.vout.entries()){
        const txout = await getTxOut(tx.result.txid, index);
        // only check unspent outputs
        if (txout.result !== null){
          const vin = tx.result.vin[0];
          if (vin.txid && vout.scriptPubKey.type === 'witness_v1_taproot'){
            const previn = await getRawTransaction(vin.txid);
            const prevout = previn.result.vout[vin.vout];
            if (prevout.scriptPubKey.type === 'witness_v1_taproot'){
              const sender_pubkey_xonly = Buffer.from(prevout.scriptPubKey.hex, 'hex').slice(2,34);
              const outputScriptPubKey = txout.result.scriptPubKey.hex;
              const outputScriptPubKeyBuffer = Buffer.from(outputScriptPubKey, 'hex');
              const chainTweakedAddress = outputScriptPubKeyBuffer.slice(2,34).toString('hex');

              const tweaked_address = await receiverTweakedSilentPaymentAddress(receiverKey, sender_pubkey_xonly);
              if (tweaked_address === chainTweakedAddress){
                console.log(chalk.yellow.italic(`Found silent payment at block ${currentBlock}`));
                _silent_utxos.push([`${tx.result.txid}`, index, vout.value*100000000]);
              }
            }
          }
        }
      }
    }

  }

  return _silent_utxos;
}

function encodePK2PaymentAddress(key){
  //const decoded = bech32m.decode(sp_address);
  //const back_to = bech32.fromWords(decoded.words);
  const hrp = 'sp1';
  //sp1
  //st1
  const x_spend = key.publicKey.slice(1, 33);
  const no_scan_no_address_reuse = Buffer.from([0]);
  const buf = Buffer.concat([no_scan_no_address_reuse, x_spend]);
  let words = bech32m.toWords(buf);
  let sp_address = bech32m.encode(hrp, words);
  return sp_address;
}

async function receiverTweakedSilentPaymentAddress(receiverKeyPair, senderPubKey){
  const receiverPrivKeyHex = receiverKeyPair.privateKey.toString('hex');
  const receiverPrivKeyUInt8 = secp.utils.hexToBytes(receiverPrivKeyHex);
  const receiverPrivKeyBuffer = Buffer.from(receiverPrivKeyUInt8);

  const receiverPubKey = secp.getPublicKey(receiverPrivKeyUInt8,true); 
  const receiverXOnlyPubkeyBuffer = Buffer.from(xOnlyPubKey(receiverPubKey));

  const senderXOnlyPubKeyBuffer = senderPubKey;

  // I*x
  const ecdh = secp256k1.publicKeyTweakMul(senderXOnlyPubKeyBuffer, receiverPrivKeyBuffer);

  // hash(I*x)
  const hashedEcdh = await secp.utils.sha256(ecdh);
  const hashedEcdhBuffer = Buffer.from(hashedEcdh);

  // X' = X + hash(I*x)*G
  const tweaked_point = secp256k1.publicKeyTweakSum(receiverXOnlyPubkeyBuffer, hashedEcdhBuffer);

  const tweaked_point_x_only = tweaked_point[0].toString('hex');

  return tweaked_point_x_only;
}

function xOnlyPubKey(publicKey){
  const myXOnlyPubkey = publicKey.slice(1, 33);
  return myXOnlyPubkey;
}
//#endregion

//#region CLI Command Handlers
async function command_createwallet(){
  let _wallet_name;
  let _method;
  let _seedwords = [];
  let _blockheight;

  let questions = [];

  console.log(
    chalk.green.bold('Creating a new wallet\n')
  );

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const q_wallet_name = function (callback) {
    rl.question('1) Name for the wallet? \n\nName [default]: ', async function (wallet_name) {
      _wallet_name = wallet_name || 'default';
      callback(null);
    });
  }

  const q_wallet_creation_method = function (callback) {
    rl.question('\n2) Create from:\n\n[a] New random key\n[b] Mnemonic Seed\n\nChooce [a]: ', async function (method) {
      _method = method || 'a';
      callback(null);
    });
  }

  const q_seedword = function (callback){
    if (_method === 'a'){
      callback(null);
      return;
    }

    const current_seedword = _seedwords.length + 1;
    rl.question(`${current_seedword === 1 ? '\n' : ''}${current_seedword}) `, async function (seedword) {
      _seedwords.push(seedword);
      callback(null);
    });
  }

  const q_blockheight = function (callback){
    if (_method === 'a'){
      callback(null);
      return;
    }

    rl.question('\n(3) Blockheight:\n\nNumber [709632]: ', async function (blockheight) {
      _blockheight = parseInt(blockheight) || 709632; // taproot activation height
      callback(null);
    });
  }


  const q_last = async function (callback) {
     // save the actual wallet on a file
     const mnemonic = generateMnemonic();
     const {result: blockCount} = await getBlockCount();

     const wallet_data = {
       mnemonic: _method === 'a' ? mnemonic : _seedwords.join(' '),
       blockheight_birthday: _method === 'a' ? blockCount : _blockheight, // num
       blockheight_cursor: _method === 'a' ? blockCount : _blockheight, // last scan
       silent_utxos: [], // [[utxoA, vout, sats]]
     }

     const path = './' + _wallet_name + '.dat';

     // Abort if wallet already exist
     try {
       if (existsSync(path)){
         throw Error;
       }
     }catch (e){
       console.error(chalk.red.bold("\nExiting: Wallet already exists"));
       process.exit(1);
     }

     try {
       writeFileSync(path, JSON.stringify(wallet_data), 'utf8');
       console.log('Wallet successfully saved to disk');
     } catch (error) {
       throw new Error("Couldn't save wallet to disk");
     }

     console.log(`\nSaved wallet on ./${_wallet_name}.dat`);
     rl.close();
  };

  questions.push(q_wallet_name);
  questions.push(q_wallet_creation_method);
  times(12, () => questions.push(q_seedword));
  questions.push(q_blockheight);
  questions.push(q_last);

  waterfall(questions);
}

async function command_scanutxos(option){
  const {wallet: path} = option;

  console.log(chalk.green.bold('Scanning for P2TR / SP coins\n'));

  let wallet = read_wallet(path);

  const seedFromValidMnemonic = mnemonicToSeedSync(wallet.mnemonic);
  const rootKeyFromValidMnemonic = bip32.fromSeed(seedFromValidMnemonic, bitcoin.networks.testnet);
  const firstKey = rootKeyFromValidMnemonic.derivePath("m/86'/0'/0'/0/0");
  const p2tr_output = createKeySpendOutput(firstKey.publicKey);
  console.warn = function() {};
  const p2tr_address = bitcoin.address.fromOutputScript(p2tr_output, bitcoin.networks.testnet);

  console.log(chalk.yellow("Syncing TXs for P2TR address"));

  const api_p2tr_utxos = await fetchAddressUTXOS(p2tr_address);
  let p2tr_utxos = [];

  for (const utxo of api_p2tr_utxos){
    p2tr_utxos.push([utxo.txid, utxo.vout, utxo.value]);
  }

  wallet.p2tr_utxos = p2tr_utxos;


  console.log(`\nFound ${chalk.red.bold(p2tr_utxos.length)} p2tr coins`);
  let silent_utxos = [];

  // Already scanned silent utxos
  for (const utxo of wallet.silent_utxos){
    silent_utxos.push(utxo);
  } 

  const {result: blockTarget} = await getBlockCount();

  console.log(chalk.yellow("\nSyncing TXs for SP address"));
  console.log(`\nScanning ${blockTarget-wallet.blockheight_cursor} missing blocks.`);
  console.log(`Starting at: ${wallet.blockheight_cursor}`);
  console.log(`Ending at: ${blockTarget}\n`);

  const scanned_silent_utxos = await fetchSilentUTXOS(firstKey, wallet.blockheight_cursor, blockTarget);
  
  for (const utxo of scanned_silent_utxos){
    silent_utxos.push(utxo);
  } 
  
  console.log(`Found ${chalk.red.bold(silent_utxos.length)} SP coins`);

  // saves current Heigh and silent_utxos
  wallet.blockheight_cursor = blockTarget;
  wallet.silent_utxos = silent_utxos;

  save_wallet(path, wallet);
}

async function command_getbalance(option){
  const {wallet: path} = option;

  console.log(chalk.green.bold('Getting balance in satoshis\n'));

  let wallet = read_wallet(path);

  // P2TR Address: qr3kasd3434fsdf
  // P2TR Balance: 3434 sats

  const seedFromValidMnemonic = mnemonicToSeedSync(wallet.mnemonic);
  const rootKeyFromValidMnemonic = bip32.fromSeed(seedFromValidMnemonic, bitcoin.networks.testnet);
  const firstKey = rootKeyFromValidMnemonic.derivePath("m/86'/0'/0'/0/0");
  const p2tr_output = createKeySpendOutput(firstKey.publicKey);
  console.warn = function() {};
  const p2tr_address = bitcoin.address.fromOutputScript(p2tr_output, bitcoin.networks.testnet);

  console.log("P2TR Address: ");
  console.log(chalk.green.italic(p2tr_address));

  console.log("\nP2TR Balance: ");

  let p2tr_balance = 0;
  for (const utxo of wallet.p2tr_utxos){
    p2tr_balance += utxo[2] || 0;
  } 
  
  console.log(chalk.yellow.italic(`${p2tr_balance} sats`));

  // Silent Address: sp13434sfdfslk
  // Silent Balance: 342349 sats
  // First get p2tr address
  
  const SILENT_ADDRESS = encodePK2PaymentAddress(firstKey);
  console.log("\nSilent Address: ");
  console.log(chalk.green.italic(SILENT_ADDRESS));


  let silent_balance = 0;

  // Already scanned silent utxos
  for (const utxo of wallet.silent_utxos){
    silent_balance += utxo[2] || 0;
  } 


  console.log("\nSilent Balance: ");
  

  console.log(chalk.yellow.italic(`${silent_balance} sats\n`));


}

async function command_listunspent(option){
  const {wallet: path} = option;

  console.log(chalk.green.bold('List unspent utxos for a wallet\n'));

  let wallet = read_wallet(path);

  const seedFromValidMnemonic = mnemonicToSeedSync(wallet.mnemonic);
  const rootKeyFromValidMnemonic = bip32.fromSeed(seedFromValidMnemonic, bitcoin.networks.testnet);
  const firstKey = rootKeyFromValidMnemonic.derivePath("m/86'/0'/0'/0/0");
  const p2tr_output = createKeySpendOutput(firstKey.publicKey);
  console.warn = function() {}; // override fromOutputScript segwit v1 warning
  const p2tr_address = bitcoin.address.fromOutputScript(p2tr_output, bitcoin.networks.testnet);

  console.log("P2TR UTXOS:");
  const p2tr_utxos = await fetchAddressUTXOS(p2tr_address);
  if (p2tr_utxos.length > 0){
    for (const utxo of p2tr_utxos){
      console.log(`${utxo.txid}:${utxo.vout}, ${utxo.value} sats`);
    }
  }else{
    console.log('None')
  }

  //sync here as well maybe ¿?

  console.log("\nSILENT UTXOS:");

  if (wallet.silent_utxos.length > 0){
    for (const utxo of wallet.silent_utxos){
      console.log(`${utxo[0]}:${utxo[1]}, ${utxo[2]} sats`);
    }
  }else{
    console.log('None')
  }
  console.log('');
}

async function command_listaddresses(option){
  const {wallet: path} = option;

  console.log(chalk.green.bold('List receiving addresses\n'));

  let wallet = read_wallet(path);

  const seedFromValidMnemonic = mnemonicToSeedSync(wallet.mnemonic);
  const rootKeyFromValidMnemonic = bip32.fromSeed(seedFromValidMnemonic, bitcoin.networks.testnet);
  const firstKey = rootKeyFromValidMnemonic.derivePath("m/86'/0'/0'/0/0");
  const p2tr_output = createKeySpendOutput(firstKey.publicKey);
  console.warn = function() {}; // override fromOutputScript segwit v1 warning
  const p2tr_address = bitcoin.address.fromOutputScript(p2tr_output, bitcoin.networks.testnet);

  console.log("P2TR Address: ");
  console.log(chalk.green.italic(p2tr_address));


  const SILENT_ADDRESS = encodePK2PaymentAddress(firstKey);
  console.log("\nSilent Address: ");
  console.log(chalk.green.italic(SILENT_ADDRESS));
  console.log('');
}

async function command_payto(address, utxo_id, utxo_vout, amount, fee_amount, option){
  const {wallet} = option;
  console.log(
    chalk.green.bold('Send sats')
  );
  console.log({option, address, utxo_id, utxo_vout, amount, fee_amount});

  // At the end of the day we always send to a P2TR address even if its a silent payment
  // The only difference is if the input is P2TR or SILENT
  
  // 1- Detect if Address is SILENT or NOT
  // 2- If the address is silent, we need to decode it to get the tweaked address
  // 3- Detect if the selected utxo is SILENT or NOT
  // 4- If the utxo is silent, use tweaked signing
  // 5- If the utxo is P2TR, use normal signing
  // 6- Get raw transaction of the utxo
  // 7- Call the transaction signer to build the signed transaction
  // 8- Broadcast the transaction


}
//#endregion

function main(){
  const program = new Command();

  program
    .command('createwallet')
    .description('Generates a wallet')
    .action(command_createwallet);

  program
    .command('scanutxos')
    .requiredOption('-w, --wallet <filename>', '')
    .description('Scans for new SP/P2TR coins')
    .action(command_scanutxos);

  program
    .command('getbalance')
    .requiredOption('-w, --wallet <filename>', '')
    .description('Prints balance in satoshis')
    .action(command_getbalance);

  program
    .command('listunspent')
    .requiredOption('-w, --wallet <filename>', '')
    .description('List unspent utxos for a wallet')
    .action(command_listunspent);

  program
    .command('listaddresses')
    .requiredOption('-w, --wallet <filename>', '')
    .description('List receiving addresses')
    .action(command_listaddresses);

  program
    .command('payto')
    .requiredOption('-w, --wallet <filename>', '')
    .argument('<sp_or_normal_address>', 'Destination address')
    .argument('<utxo_id>', 'UTXO id')
    .argument('<utxo_vout>', 'UTXO vout')
    .argument('<amount>', 'Amount in Satoshis')
    .argument('<fee_amount>', 'Fee amount in Satoshis')
    .description('Sends sats')
    .action(command_payto);

  program.parse();
}

main();
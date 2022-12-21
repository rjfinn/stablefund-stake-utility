#!/usr/local/bin/node

import conf from '@tsmx/secure-config';
import StakeUtil from "./src/StakeUtil.js";
const config = conf();

const siteName = "stablefund.app";
import { abi } from "./src/abi/stablefundv2.js";

const stake = StakeUtil({
    siteName:           siteName,
    blockchain:         "Polygon",
    symbol:             "SFUSD",
    contractAddress:    "0x21fBDa0DB715656B93bA588BdDf4cd9f85BB1114",
    tokenAddress:       '0x93FEe753b548b4Cf93C41AdA062F80DE12710dB8',
    approveEveryTxn:    false,
    walletConfig:       config[siteName].wallets,
    xferWallet:         config[siteName].xfer_wallet,
    amountToLeave:      config[siteName].leave,
    restakeRate:        config[siteName].hasOwnProperty('restake_rate') ? config[siteName].restake_rate : 1.0,
    abi:                abi,
    JsonProvider:       'https://polygon-rpc.com/',
    //JsonProvider:       'https://matic.getblock.io/mainnet/?api_key='+config.getblock_key,
    //WSSProvider:        'wss://matic.getblock.io/mainnet/?api_key=' + config.getblock_key,
    gasPremium:         0,
    gasStation:         'https://gasstation-mainnet.matic.network/v2',
    gasPriority:        'standard',  // safeLow, standard, fast
    maxGasFeeForAuto:   150,
    compoundsPerDay:    config[siteName].compounds_per_day ? config[siteName].compounds_per_day : 1,
    compoundMin:        config[siteName].compound_min ? config[siteName].compound_min : 0.0,
    checkBalanceRetrySeconds:   5,
    checkBalanceRetryAttempts:  100,
    CMCAPIKey:          config.cmc_api_key
});

const args = process.argv.slice(2);
await stake.run(args);


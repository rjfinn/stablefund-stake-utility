#!/usr/sbin/node

import conf from '@tsmx/secure-config';
import StakeUtil from "./src/StakeUtil.js";
const config = conf();

const siteName = "stablefund.appBNB";
import { abi } from "./src/abi/stablefundbnb.js";

const stake = StakeUtil({
    siteName:           siteName,
    blockchain:         "bsc",
    symbol:             "BNB",
    contractAddress:    "0x4F2bC1d99C953e0053F5bb9A6855CF7A5CBe66Fa",
    walletConfig:       config[siteName].wallets,
    xferWallet:         config[siteName].xfer_wallet,
    amountToLeave:      config[siteName].leave,
    restakeRate:        config[siteName].hasOwnProperty('restake_rate') ? config[siteName].restake_rate : 1.0,
    abi:                abi,
    JsonProvider:       'https://bsc-dataseed.binance.org/',
    //JsonProvider:       'https://bsc.getblock.io/mainnet/?api_key='+config.getblock_key,
    //WSSProvider:        'wss://bsc.getblock.io/mainnet/?api_key=' + config.getblock_key,
    gasPremium:         0,
    gasStation:         'https://owlracle.info/bsc/gas?apikey='+config.owlracle_key,
    maxGasFeeForAuto:   10,
    compoundsPerDay:    config[siteName].compounds_per_day ? config[siteName].compounds_per_day : 1,
    compoundMin:        config[siteName].compound_min ? config[siteName].compound_min : 0.0,
    checkBalanceRetrySeconds:   5,
    checkBalanceRetryAttempts:  100,
    CMCAPIKey:          config.cmc_api_key
});

const args = process.argv.slice(2);
await stake.run(args);


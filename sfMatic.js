import conf from '@tsmx/secure-config';
import StakeUtil from "./src/StakeUtil.js";
const config = conf();

const siteName = "stablefund.app";
import { abi } from "./abi/stablefund.app.js";

const stake = StakeUtil({
    siteName:           siteName,
    symbol:             "MATIC",
    contractAddress:    "0x0dC733a0C086a113a88DDAb7C4160dC097B6F89A",
    walletConfig:       config[siteName].wallets,
    xferWallet:         config[siteName].xfer_wallet,
    amountToLeave:      config[siteName].leave,
    restakeRate:        config[siteName].restake_rate ? config[siteName].restake_rate : 1.0,
    abi:                abi,
    JsonProvider:       'https://matic.getblock.io/mainnet/?api_key='+config.getblock_key,
    gasPremium:         10,
    gasStation:         'https://gasstation-mainnet.matic.network/v2',
    gasPriority:        'fast',  // for Polygon
    compoundsPerDay:    config[siteName].compounds_per_day ? config[siteName].compounds_per_day : 1,
    compundMin:         config[siteName].compound_min ? config[siteName].compound_min : 0.0,
    checkBalanceRetrySeconds:   1,
    checkBalanceRetryAttempts:  1000,
    CMCAPIKey:          config.cmc_api_key
});

const args = process.argv.slice(2);
await stake.run(args);


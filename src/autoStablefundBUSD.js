import { ethers } from 'ethers';
import { abi } from "./abi/stablefundbusd.js";
import { abi20 } from "./abi/bep20.js";
import got from 'got';
import moment from 'moment';
import conf from '@tsmx/secure-config';
//import getPrice from 'crypto-price';
//import web3 from 'web3';
const config = conf();

const siteName = "stablefund.appBUSD";
const symbol = "BUSD";
const contractAddress = '0xfBbc24CA5518898fAe0d8455Cb265FaAA66157C9';
const tokenAddress = '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56';
const expectedDailyReturn = 0.015;
const provider = new ethers.providers.JsonRpcProvider(`https://bsc-dataseed.binance.org/`);
const chainScan = 'https://www.bscscan.com/tx/';
const gasStation = 'https://owlracle.info/bsc/gas?apikey=88a59354fb434998844d64b88afe1b2a';
const gasPremium = 10 // percentage
let gasPrice = ethers.BigNumber.from(500000); 
let gasLimit = ethers.BigNumber.from(400000); 
const checkBalanceRetrySeconds = 5;
const momentFormat = 'MMM-DD-YYYY hh:mm:ss A +UTC';
const compoundsPerDay = config[siteName].compounds_per_day ? config[siteName].compounds_per_day : 1;
const compoundMin = config[siteName].compound_min ? config[siteName].compound_min : 0.0;
const minDeposit = 2;
const withdrawEligibleAge = 28; // days
const approveEveryTxn = true;

// The time interval between each rebake to reach the desired number of rebakes per day
const compoundInterval = 24 / compoundsPerDay;
const POLLING_INTERVAL = hoursToMiliseconds(compoundInterval);

let price = 0.0;

for (const [key, value] of Object.entries(config[siteName].wallets)) {
    console.log('Added wallet:', key, config[siteName].wallets[key].address);
}

// Smart contract
const contract = new ethers.Contract(contractAddress, abi, provider);
//const signedContract = contract.connect(wallet);

// Token contract
const tokenContract = new ethers.Contract(tokenAddress, abi20, provider);

// CoinAPI price
// async function setPrice(symbol = symbol) {
//     try {
//         const response = await got(
//             "https://rest.coinapi.io" + "/v1/exchangerate/" + symbol + "/USD",
//             {
//                 headers: {
//                     'X-CoinAPI-Key': config.coinapi_key
//                 }
//             }
//         ).json();
//         console.log("Current",symbol,"price:",`\$${response.rate.toFixed(4)}`);
//         price = response.rate;
//         return response.rate;
//     } catch (err) {
//         console.log(err);
//         return false;
//     }
// }

// CoinMarketCap price
async function setPrice(_symbol, convert='USD') {
    if(!_symbol) {
        _symbol = symbol;
    }
    try {
        const response = await got(
            'https://pro-api.coinmarketcap.com/v2/tools/price-conversion',
            {
                searchParams: {
                    symbol: _symbol,
                    amount: 1.0,
                    convert: convert
                },
                headers: {
                    'X-CMC_PRO_API_KEY': config.cmc_api_key
                }
            }
        ).json();
        console.log("Current",_symbol,"price:",`\$${response.data[0].quote['USD'].price.toFixed(4)}`);
        price = Number(response.data[0].quote['USD'].price);
        return price;
    } catch (err) {
        console.log(err);
        return false;
    }
}

// avoid underpriced transaction by getting current gas prices
// for replanting and harvesting transactions
async function setGasFee() {
    try {
        gasPrice = await provider.getGasPrice();
        const data = await got(gasStation).json();

        let gasPriceB = ethers.utils.parseUnits(data.speeds[2].gasPrice.toString(),'gwei');

        if(gasPriceB.gt(gasPrice)) {
            gasPrice = gasPriceB;
        }
        gasPrice = gasPrice.mul(gasPremium * 100).div(100);
        // //console.log(data);
        // maxPriorityFeePerGas = ethers.utils.parseUnits(
        //     Math.ceil(data[gasPriority].maxPriorityFee) + '',
        //     'gwei'
        // )
        // maxFeePerGas = ethers.utils.parseUnits(
        //     Math.ceil(data[gasPriority].maxFee) + '',
        //     'gwei'
        // )
        // //console.log('max priority fee:', maxPriorityFeePerGas.toString());
        // //console.log('max fee: ', maxFeePerGas.toString());
    } catch(err) {
        console.log("Error getting gas fee", err);
    }
}

// await setGasFee();

// let gases = await provider.getGasPrice();
// console.log(gases.toString());
// console.log(maxPriorityFeePerGas.toString());
// console.log(maxFeePerGas.toString());
// process.exit(0);

async function deposits() {
    console.log('Deposit funds from all wallets for',siteName);
    for await (const [key, value] of Object.entries(config[siteName].wallets)) {
        await depositByKeys(value.private);
    }
}

async function depositByKey(key) {
    const wallet = new ethers.Wallet(key, provider);
    const signedContract = contract.connect(wallet);
    const signedToken = tokenContract.connect(wallet);
    await deposit(wallet, signedContract, signedToken);
}

async function deposit(wallet, signedContract, signedToken, amount = 0.0) {
    console.log('\nDeposit from:', wallet.address);
    
    let xferAmount = 0.0;
    if(amount <= 0.0) {	
        let rawBalance = await tokenContract.balanceOf(wallet.address);
        let myBalance = Number(parseFloat(ethers.utils.formatEther(rawBalance)).toFixed(3));
        console.log('Wallet balance:', myBalance);

        xferAmount = Math.floor(myBalance) - config[siteName].leave;
    } else {
        xferAmount = amount;
    }

    console.log('Transfer amount:', xferAmount);
    let parsedAmount = ethers.utils.parseEther(xferAmount.toString());

    if (xferAmount > minDeposit) {
        // approve token xfer 1st
        if(approveEveryTxn) {
            const approval = await signedToken.approve(contractAddress, parsedAmount, {
                gasPrice: gasPrice,
                gasLimit: gasLimit
            });
        }

        // actual deposit
        const tx = await signedContract.deposit(parsedAmount, {
            gasPrice: gasPrice,
            gasLimit: gasLimit
        });

        console.log('Successfully deposited:', xferAmount, symbol);
        console.log(`chainScan: ${chainScan}${tx.hash}`)
        console.log('TX Hash:', tx.hash);
        //console.log('TX Fee (Gas):', ethers.utils.formatEther(tx.gasLimit * tx.gasPrice), symbol, '\n');
    } else {
        console.log('Tranfer amount too low.');
    }

    //let deposits = await getDeposits(wallet.address);
    //console.log(deposits);
}

async function getDeposits(address, showDeposits = false) {
    const ownedDeposits = await contract.getOwnedDeposits(address);
    let deposits = new Array();
    const now = Date.now().valueOf();
    //ownedDeposits.forEach(async (element) => {
    for(const element of ownedDeposits) {
        const dep = await contract.depositState(element.toString());
        // only care about active deposits
        // a deposit is no longer active if it is withdrawn
        if(dep.state) {
            //const rewards = await contract.getClaimableReward(element.toString());
            let timestamp = Number(dep.depositAt.toString());
            let age = Number(parseFloat((now/1000 - timestamp)/86400).toFixed(1));
            let deposit = {
                id: element.toString(),
                amount: Number(ethers.utils.formatEther(dep.depositAmount)),
                timestamp: timestamp,
                age: age,
                withdrawEligible: (age >= withdrawEligibleAge)
                //rewards: Number(ethers.utils.formatEther(rewards))
            };
            if(showDeposits) {
                let PS = '';
                if(deposit.withdrawEligible) {
                    PS += '*';
                }
                console.log('\t',deposit.id,':',Number(deposit.amount.toFixed(2)), '\tage:', age, 'day(s)',PS);
            }
            deposits.push(deposit);
        }
    };
    //console.log(deposits);
    return deposits;
}

async function getBalance(address) {
    const rawBalance = await tokenContract.balanceOf(address); //provider.getBalance(address);
    const balance = Number(parseFloat(ethers.utils.formatEther(rawBalance)).toFixed(5));
    return balance;
}

async function balances(index = undefined) {
    const contractBalance = await getBalance(contractAddress);
    console.log('Contract balance: ', Number(contractBalance.toFixed(2)), 
        `(\$${(contractBalance * price).toFixed(2)})`);

    let totalRewards = 0.0;
    for await (const [key, value] of Object.entries(config[siteName].wallets)) {
        if(index != undefined && config[siteName].wallets[index].address != value.address) {
            continue;
        }

        let balance = await getBalance(value.address);
        console.log();
        console.log(key, 'wallet balance:', Number(balance.toFixed(2)), 
            `(\$${(balance * price).toFixed(2)})`);

        const rawRewards = await contract.getAllClaimableReward(value.address);
        const rewards = Number(parseFloat(ethers.utils.formatEther(rawRewards)));
        totalRewards += rewards;
        console.log('Pending rewards:', Number(rewards.toFixed(2)), 
            `(\$${(rewards * price).toFixed(2)})`);
    }
    console.log('\nTotal pending rewards:', Number(totalRewards.toFixed(2)), 
        `(\$${(totalRewards * price).toFixed(2)})`);

    return;
}

async function fullBalances(index = undefined, showDeposits = false) {
    const contractBalance = await getBalance(contractAddress);
    console.log('Contract balance: ', Number(contractBalance.toFixed(2)), 
        `(\$${(contractBalance * price).toFixed(2)})`);

    //const now = Date.now().valueOf();

    let totalCapital = 0.0;
    let totalRewards = 0.0;
    let totalEligible = 0.0;
    for await (const [key, value] of Object.entries(config[siteName].wallets)) {
        if(index && config[siteName].wallets[index].address != value.address) {
            continue;
        }
        let balance = await getBalance(value.address);
        console.log();
        console.log(key, 'wallet balance:', Number(balance.toFixed(2)), 
            `(\$${(balance * price).toFixed(2)})`);

        if(showDeposits) {
            console.log('Deposits:');
        }
        let deposits = Array.from(await getDeposits(value.address, showDeposits));
        let capital = 0.0;
        let eligible = 0.0;
        //let rewards = 0.0;
        
        deposits.forEach( element => {
            capital += element.amount;
            if(element.withdrawEligible) {
                eligible += element.amount;
            }
        });
        console.log('Capital:', Number(capital.toFixed(2)), 
            `(\$${(capital * price).toFixed(2)})`);
        console.log('Withdraw eligible:', Number(eligible.toFixed(2)),
            `(\$${(eligible * price).toFixed(2)})`,
            `${(eligible/capital*100).toFixed(2)}%`);

        const rawRewards = await contract.getAllClaimableReward(value.address);
        const rewards = Number(parseFloat(ethers.utils.formatEther(rawRewards)));
        const dailyExpectedWallet = (expectedDailyReturn * capital).toFixed(2);

        console.log('Pending rewards:', Number(rewards.toFixed(2)), 
            `(\$${(rewards * price).toFixed(2)})`,
            `${(rewards/dailyExpectedWallet*100).toFixed(2)}%`);
  
        console.log('Expected daily:',Number(dailyExpectedWallet),
            `(\$${(dailyExpectedWallet * price).toFixed(2)})`);
        let hourly = (dailyExpectedWallet / 24).toFixed(2);
        console.log('Expected hourly:',Number(hourly),
            `(\$${(hourly * price).toFixed(2)})`);
        console.log('Expected next compound:',Number(dailyExpectedWallet / compoundsPerDay));
        
        totalCapital += capital;
        totalRewards += rewards;
        totalEligible += eligible;

        //let rewards = await contract.getAllClaimableReward(value.address);
        //console.log(key, ' claimable rewards: ',parseFloat(ethers.utils.formatEther(rewards)).toFixed(2));
    }
    const expectedDailyAmount = (expectedDailyReturn * totalCapital).toFixed(2);

    console.log('\nTotal capital:',Number(totalCapital.toFixed(2)), 
        `(\$${(totalCapital * price).toFixed(2)})`);
    console.log('Total withdraw eligible:',Number(totalEligible.toFixed(2)), 
        `(\$${(totalEligible * price).toFixed(2)})`,
        `${(totalEligible/totalCapital*100).toFixed(2)}%`);
    console.log('Total pending rewards:',Number(totalRewards.toFixed(2)),
        `(\$${(totalRewards * price).toFixed(2)})`,
        `${(totalRewards/expectedDailyAmount*100).toFixed(2)}%`);
    console.log('Total expected daily:',Number(expectedDailyAmount),
        `(\$${(expectedDailyAmount * price).toFixed(2)})`);
    let hourlyAmount = (expectedDailyAmount / 24).toFixed(2);
    console.log('Total expected hourly:',Number(hourlyAmount),
        `(\$${(hourlyAmount * price).toFixed(2)})`);
    console.log('Expected next compound:',Number(expectedDailyAmount / compoundsPerDay));
}

async function withdrawCapital() {
    console.log('Withdraw all eligible capital for all wallets on',siteName);
    for await (const [key, value] of Object.entries(config[siteName].wallets)) {
        await withdrawCapitalByKey(value.private);
    }
}

async function withdrawCapitalByKey(key) {
    const wallet = new ethers.Wallet(key, provider);
    const signedContract = contract.connect(wallet);
    const capital = await withdrawByWallet(wallet, signedContract);

    return capital;
}

async function withdrawByWallet(wallet, signedContract) {
    //TODO
    const capital = 0;

    return capital;
}

async function withdrawByDeposit(key, depositID) {
    let wallet = new ethers.Wallet(key, provider);
    let signedContract = contract.connect(wallet);

    console.log('Withdraw deposit',depositID,'from',wallet.address);
    await withdrawByDeposit_call(signedContract, depositID);
}

async function withdrawByDeposit_call(signedContract, depositID) {
    try {
        let deposit = await contract.depositState(depositID.toString());
        // TODO: deposit itself vs depositID, check age
        let amount = Number(ethers.utils.formatEther(deposit.depositAmount));
        let rawReward = await contract.getClaimableReward(depositID.toString());
        let reward = Number(ethers.utils.formatEther(rawReward));
        let total = amount + reward;
        console.log('Withdrawing deposit of',amount,'and reward of',reward);

        const tx = await signedContract.withdrawCapital(depositID,{
            gasPrice: gasPrice,
            gasLimit: gasLimit
        });

        console.log('Successfully withdrew:', total, symbol);
        console.log(`chainScan: ${chainScan}${tx.hash}`)
        console.log('TX Hash:', tx.hash);
        console.log('TX Fee (Gas):', ethers.utils.formatEther(tx.gasLimit * tx.gasPrice), symbol, '\n');

        return amount;
    } catch (err) {
        console.log('Problem with withdraw:',err);
        return false;
    }
}

async function claimRewardsByKey(key) {
    const wallet = new ethers.Wallet(key, provider);
    const signedContract = contract.connect(wallet);
    const rewards = await claimRewardsByWallet(wallet, signedContract);

    return rewards;
}

async function claimRewardsByWallet(wallet, signedContract, rewards = undefined) {
    try {
        if (!rewards) {
            const rawRewards = await contract.getAllClaimableReward(wallet.address);
            rewards = Number(parseFloat(ethers.utils.formatEther(rawRewards)));
        }

        //console.log('claim',rewards.toString());
        const tx = await signedContract.claimAllReward({
            gasPrice: gasPrice,
            gasLimit: gasLimit
        });
        //console.log(tx);

        console.log('Successfully claimed:', rewards, symbol);
        console.log(`chainScan: ${chainScan}${tx.hash}`)
        console.log('TX Hash:', tx.hash);
        console.log('TX Fee (Gas):', ethers.utils.formatEther(tx.gasLimit * tx.gasPrice), symbol, '\n');

        return rewards;
    } catch (err) {
        console.log('Could not claim rewards for', wallet.address, err);
        return;
    }
}

async function claimAllRewards() {
    console.log('Claim rewards for all wallets on',siteName);
    for await (const [key, value] of Object.entries(config[siteName].wallets)) {
        await claimRewardsByKey(value.private);
    }
}

async function walletTransfer(fromIndex, toIndex) {
    const fromWallet = new ethers.Wallet(config[siteName].wallets[fromIndex].private, provider);
    const toWallet = new ethers.Wallet(config[siteName].wallets[toIndex].private, provider);
    const rawBalance = await provider.getBalance(fromWallet.address);
    const myBalance = Number(parseFloat(ethers.utils.formatEther(rawBalance)).toFixed(3));
    
    const xferAmount = Math.floor(myBalance) - config[siteName].leave;

    console.log('Wallet transfer of:', xferAmount);

    await transfer(fromWallet, toWallet.address, xferAmount);
}

async function transfer(wallet, toAddress, amount) {
    try {
        if(wallet.address.toString() == toAddress.toString()) {
            console.log('Skipping transfer between the same address',wallet.address)
        } else {
            console.log('Transfer from:', wallet.address, 'to', config[siteName].xfer_wallet);
            const preBalance = await getBalance(toAddress);
            const walletSigner = wallet.connect(provider);
            const tx = await walletSigner.sendTransaction({
                from: wallet.address,
                to: toAddress.toString(),
                value: String(ethers.utils.parseEther(amount.toString())),
                gasPrice: gasPrice,
                gasLimit: gasLimit
            });

            let balance = 0.0;
            do {
                await sleep(checkBalanceRetrySeconds * 1000);
                balance = await getBalance(toAddress);
                console.log('Destination balance currently:', balance);
            } while (balance < (preBalance + amount));

            console.log('Successfully transferred:', amount, symbol);
            console.log(`chainScan: ${chainScan}${tx.hash}`)
            console.log('TX Hash:', tx.hash);
            console.log('TX Fee (Gas):', ethers.utils.formatEther(tx.gasLimit * tx.gasPrice), symbol, '\n');
        }
    } catch (err) {
        console.log("Could not transfer:", err);
    }
}

async function compoundWallet(key) {
    const wallet = new ethers.Wallet(key, provider);
    const signedContract = contract.connect(wallet);
    const signedToken = tokenContract.connect(wallet);

    console.log('\nCompound wallet:',wallet.address);

    const rawRewards = await contract.getAllClaimableReward(wallet.address);
    //console.log('rawRewards',rawRewards);
    let rewards = Number(parseFloat(ethers.utils.formatEther(rawRewards)));
    let balance = 0;
    //console.log('rewards',rewards);
    if (rewards - config[siteName].leave >= compoundMin) {
        const preBalance = await getBalance(wallet.address);
        //console.log('prebalance',preBalance);
        const claimed = await claimRewardsByWallet(wallet, signedContract, rewards);
        //console.log('after claiming rewards',claimed);

        if(claimed) {
            // wait for the rewards to show up in the wallet
            do {
                await sleep(checkBalanceRetrySeconds * 1000);
                balance = await getBalance(wallet.address);
                console.log('Balance currently:', balance);
            } while (balance < (preBalance + rewards - config[siteName].leave));

            let depAmount = (Math.floor(balance) * config[siteName].restake_rate) - config[siteName].leave;
            if(depAmount >= minDeposit) {
                await deposit(wallet, signedContract, signedToken, depAmount);
            }

            if(config[siteName].restake_rate < 1) {
                await transfer(wallet, config[siteName].xfer_wallet, Math.floor(balance) * (1-config[siteName].restake_rate) - config[siteName].leave);
            }
        } else {
            console.log('Reward claim of',Number(rewards.toFixed(2)),'failed.');
        }
    } else {
        console.log('Rewards of',Number(rewards.toFixed(2)),'too low for compounding at this time');
        balance = await getBalance(wallet.address);
        if(balance - config[siteName].leave >= compoundMin) {
            console.log('\t...but existing balance can be deposited');
            await deposit(wallet, signedContract, signedToken, balance - config[siteName].leave);
        }
    }
}

async function compoundWallets() {
    console.log('Compound all wallets for',siteName);
    for await (const [key, value] of Object.entries(config[siteName].wallets)) {
        await compoundWallet(value.private);
    }
}

async function autoCompound(consolidate = false) {
    console.log('Start autocompounding every',compoundInterval,'hours');
    setIntervalAsync(async () => { await autoCompoundDriver(consolidate) }, Number(POLLING_INTERVAL) + randomTimeAdjust());
}

async function autoCompoundDriver(consolidate = false) {
    console.log('\nCompouding at',moment().format(momentFormat));

    //try {
        await setPrice();
        await setGasFee();
        await compoundWallets();
        if(consolidate) {
            const walletKeys = Object.keys(config[siteName].wallets);
            const walletIndex = walletKeys[walletKeys.length - 1];
            console.log('\nConsolodiating rewards into', config[siteName].wallets[walletIndex].name);
            await depositByKey(config[siteName].wallets[walletIndex].private);
        }
    // } catch(err) {
    //     console.log(err);
    // }
}

async function consolidate() {
    await autoCompoundDriver(true);
}

async function run() {
    let daemon = false;
    // assumes first arg is "node" and second is this file
    const myArgs = process.argv.slice(2);
    if(myArgs[0]) {
        switch (myArgs[0]) {
            case 'transfer':
            case 'xfer':
                await setPrice();
                await setGasFee();
                await walletTransfer(myArgs[1],myArgs[2]);
                break;
            case 'withdraw':
            case 'capital':
            case 'withdrawcapital':
                await setPrice();
                await setGasFee();
                if(myArgs[1]) {
                    if(myArgs[2]) {
                        await withdrawByDeposit(config[siteName].wallets[myArgs[1]].private, myArgs[2]);
                    } else {    
                        await withdrawCapitalByKey(config[siteName].wallets[myArgs[1]].private);
                    }
                } else {
                    await withdrawCapital();
                }
                break;
            case 'claim':
            case 'claimrewards':
            case 'rewards':
                await setPrice();
                await setGasFee();
                if(myArgs[1]) {
                    await claimRewardsByKey(config[siteName].wallets[myArgs[1]].private);
                } else {
                    await claimAllRewards();
                }
                break;
            case 'comp':
            case 'compound':
                await setPrice();
                await setGasFee();
                if(myArgs[1]) {
                    await compoundWallet(config[siteName].wallets[myArgs[1]].private);
                } else {
                    await compoundWallets();
                }
                break;
            case 'auto': 
            case 'autocomp':
            case 'autocompound':
                daemon = true;
                await autoCompound();
                break;
            case 'con':
            case 'consol':
            case 'consolidate':
                await consolidate();
                break;
            case 'autocon':
            case 'autoconsol':
            case 'autoconsolidate':
                daemon = true;
                await autoCompound(true);
                break;
            case 'dep':
            case 'deposit':
                //await setPrice();
                await setGasFee();
                if(myArgs[1]) {
                    await depositByKey(config[siteName].wallets[myArgs[1]].private)
                } else {
                    await deposits();
                }
                break;
            case 'fulldeposits':
            case 'fulldep':
            case 'fulldeps':
            case 'depositlist':
            case 'deplist':
                await setPrice();
                if(myArgs[1]) {
                    await fullBalances(myArgs[1], true);
                } else {
                    await fullBalances(undefined, true);
                }
                break;
            case 'fullbal':
            case 'full':
            case 'fullbalance':
            case 'fullbalances':
                await setPrice();
                if(myArgs[1]) {
                    await fullBalances(myArgs[1], false);
                } else {
                    await fullBalances();
                }
                break;
            case 'bal':
            case 'balance':
            case 'balances':
            default:
                await setPrice();
                if(myArgs[1]) {
                    await balances(myArgs[1]);
                } else {
                    await balances();
                }
        }
    }
    if(!daemon) {
        process.exit(0);
    }
}

function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

function hoursToMiliseconds(hrs) {
    return hrs * 60 * 60 * 1000;
}

const setIntervalAsync = (fn, ms) => {
    //console.log('setInterval',ms);
    if(ms < 0) {
        ms = -ms;
    }
    fn().then(() => {
        setTimeout(() => setIntervalAsync(fn, ms), ms);
    });
};

function randomTimeAdjust() {
    const random_min_buffer = 4;
    let amount = Math.random() * 1000 * 60 * random_min_buffer;
    if(Math.random() < 0.5) {
        amount = -amount;
    }
    return Number(amount);
}

run()
    .catch((err) => {
        console.log(err);
        process.exit(1);
    });
// .then(() => process.exit(0))



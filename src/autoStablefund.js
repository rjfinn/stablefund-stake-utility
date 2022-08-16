import { BigNumber, ethers } from 'ethers';
import { abi } from "./abi/stablefund.app.js";
import got from 'got';
import moment from 'moment';
import conf from '@tsmx/secure-config';
import readline from 'readline';
//import getPrice from 'crypto-price';
//import web3 from 'web3';
const config = conf();

const siteName = "stablefund.app";
const symbol = "MATIC";
const polyContractAddress = '0x0dC733a0C086a113a88DDAb7C4160dC097B6F89A';
const expectedDailyReturn = 0.015;
//const provider = new ethers.providers.JsonRpcProvider(`https://polygon-rpc.com/`);
//const provider = new ethers.providers.WebSocketProvider('wss://matic.getblock.io/mainnet/?api_key=' + config.getblock_key);
const provider = new ethers.providers.JsonRpcProvider('https://matic.getblock.io/mainnet/?api_key='+config.getblock_key);
const polyScan = 'https://polygonscan.com/tx/';
const gasStation = 'https://gasstation-mainnet.matic.network/v2';
let maxFeePerGas = ethers.BigNumber.from(20000000000); // fallback to 20 gwei
let maxPriorityFeePerGas = ethers.BigNumber.from(20000000000); // fallback to 20 gwei
let gasLimit = ethers.BigNumber.from(8000000);
let gasPrice = ethers.BigNumber.from(20000000);
const gasPriority = 'safeLow'; // fast, safeLow, standard
const gasPremium = 10;  // percentage
const checkBalanceRetrySeconds = 5;
const checkBalanceRetryAttempts = 21;
const momentFormat = 'MMM-DD-YYYY hh:mm:ss A +UTC';
const compoundsPerDay = config[siteName].compounds_per_day ? config[siteName].compounds_per_day : 1;
const compoundMin = config[siteName].compound_min ? config[siteName].compound_min : 0.0;
const minDeposit = 10;
const withdrawEligibleAge = 28; // days

// The time interval between each rebake to reach the desired number of rebakes per day
const compoundInterval = 24 / compoundsPerDay;
const POLLING_INTERVAL = hoursToMiliseconds(compoundInterval);

let price = 0.0;

for (const [key, value] of Object.entries(config[siteName].wallets)) {
    console.log('Added wallet:', key, config[siteName].wallets[key].address);
}

// Smart contract
const contract = new ethers.Contract(polyContractAddress, abi, provider);
//const signedContract = contract.connect(wallet);

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
async function setPrice(_symbol, convert = 'USD') {
    if (!_symbol) {
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
        console.log("Current", _symbol, "price:", `\$${response.data[0].quote['USD'].price.toFixed(4)}`);
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
        // let blockNum = await provider.getBlockNumber();
        // let block = await provider.getBlock(blockNum);
        // gasLimit = block.gasLimit;

        //gasPrice = await provider.getGasPrice();
        const data = await got(gasStation).json();

        maxPriorityFeePerGas = ethers.utils.parseUnits(
            Math.ceil(data[gasPriority].maxPriorityFee) + '',
            'gwei'
        );

        maxFeePerGas = ethers.utils.parseUnits(
            Math.ceil(data[gasPriority].maxFee) + '',
            'gwei'
        );

        if(gasPremium != 0) {
            let premium = BigNumber.from(gasPremium + 100);
            maxPriorityFeePerGas = maxPriorityFeePerGas.mul(premium).div(BigNumber.from(100));
            maxFeePerGas = maxFeePerGas.mul(premium).div(BigNumber.from(100));
        }
        

        // if (maxPriorityFeePerGas.gt(gasPrice)) {
        //     gasPrice = maxPriorityFeePerGas;
        // }
        //gasPrice = gasPrice.mul(100 + gasPremium).div(100);

        //console.log('gasLimit:',ethers.utils.formatUnits(gasLimit,'wei'));
        console.log('maxPriorityFeePerGas:', ethers.utils.formatUnits(maxPriorityFeePerGas, 'gwei'), 'gwei');
        console.log('maxFeePerGas:', ethers.utils.formatUnits(maxFeePerGas, 'gwei'), 'gwei');

        //gasLimit = maxPriorityFeePerGas;
        //console.log('gasLimit',gasLimit.toString());
        //console.log('gasPrice',gasPrice);
        // console.log('max priority fee:', maxPriorityFeePerGas.toString());
        // console.log('max fee: ', maxFeePerGas.toString());
        //process.exit(0);
    } catch (err) {
        console.log("Error getting gas fee", err);
    }

    //process.exit(0);
}

// await setGasFee();

// let gases = await provider.getGasPrice();
// console.log(gases.toString());
// console.log(maxPriorityFeePerGas.toString());
// console.log(maxFeePerGas.toString());
// process.exit(0);

async function deposits() {
    console.log('Deposit funds from all wallets for', siteName);
    for await (const [key, value] of Object.entries(config[siteName].wallets)) {
        await depositByKeys(value.private);
    }
}

async function depositByKey(key) {
    const wallet = new ethers.Wallet(key, provider);
    const signedContract = contract.connect(wallet);
    await deposit(wallet, signedContract);
}

async function deposit(wallet, signedContract, amount = 0.0) {
    console.log('\nDeposit from:', wallet.address);

    let xferAmount = 0.0;
    if (amount <= 0.0) {
        let rawBalance = await provider.getBalance(wallet.address);
        let myBalance = Number(parseFloat(ethers.utils.formatEther(rawBalance)).toFixed(3));
        console.log('Wallet balance:', myBalance);

        xferAmount = Math.floor(myBalance) - config[siteName].leave;
    } else {
        xferAmount = amount;
    }

    console.log('Transfer amount:', xferAmount);

    if (xferAmount > minDeposit) {
        const depositValue = String(ethers.utils.parseEther(xferAmount.toString()));
        //const estimatedGas = await signedContract.estimateGas.deposit({ value: depositValue });

        const preBalance = await getBalance(wallet.address);

        const tx = await signedContract.deposit({
            value: depositValue,
            //gasLimit: Math.max(gasLimit, estimatedGas),
            gasLimit: gasLimit,
            maxPriorityFeePerGas: maxPriorityFeePerGas,
            maxFeePerGas: maxFeePerGas
        });

        let balance = 0.0;
        let count = 0;
        do {
            await sleep(checkBalanceRetrySeconds * 1000 * count);
            balance = await getBalance(wallet.address);
            console.log('Destination balance currently:', balance);
            count += 1;
        } while (balance == preBalance && count <= checkBalanceRetryAttempts);

        // console.log('balance',balance);
        // console.log('preBalance',preBalance);
        // console.log('xferAmount',xferAmount);
        if(balance > (preBalance - xferAmount)) {
            console.log('Error with deposit');
            const errTxn = await provider.getTransaction(tx.hash);
            try {
                let code = await provider.call(errTxn, errTxn.blockNumber);
                console.log(code);
            } catch (err) {
                console.log(err);
                console.log(err.data.toString());
            }
        } else if (count <= checkBalanceRetryAttempts || balance < (preBalance + amount)) {
            console.log('Deposited:', xferAmount, symbol);
            console.log(`polyScan: ${polyScan}${tx.hash}`)
            console.log('TX Hash:', tx.hash);
            //console.log('TX Fee (Gas):', ethers.utils.formatEther(tx.gasLimit * tx.gasPrice), symbol, '\n');
        }
    } else {
        console.log('Tranfer amount too low.');
    }

    //let deposits = await getDeposits(wallet.address);
    //console.log(deposits);
    console.log('');
}

async function getDepositState(depositID) {
    const dep = await contract.depositState(depositID.toString());
    // only care about active deposits
    // a deposit is no longer active if it is withdrawn
    if (dep.state) {
        //const rewards = await contract.getClaimableReward(element.toString());
        let timestamp = Number(dep.depositAt.toString());
        let age = Number(parseFloat((now / 1000 - timestamp) / 86400).toFixed(1));
        let deposit = {
            id: element.toString(),
            amount: Number(ethers.utils.formatEther(dep.depositAmount)),
            timestamp: timestamp,
            age: age,
            withdrawEligible: (age >= withdrawEligibleAge)
            //rewards: Number(ethers.utils.formatEther(rewards))
        };
        return deposit;
    } else {
        return false;
    }
}

async function fetchDepositState(id) {
    let dep = await contract.depositState(id);
    return {
        id: id,
        depositAt: dep.depositAt,
        depositAmount: dep.depositAmount,
        state: dep.state
    }
}

async function getDeposits(address, showDeposits = false) {
    const ownedDeposits = await contract.getOwnedDeposits(address);

    let deposits = new Array();
    const now = Date.now().valueOf();

    //console.time('main');

    // fetch all the deposit structs in parallel
    const depStates = ownedDeposits.map((depID) => {
        const id = depID.toString();
        return fetchDepositState(id);
    });
    const result = await Promise.all(depStates);

    result.map((dep) => {
        if (dep.state) {
            let timestamp = Number(dep.depositAt.toString());
            let age = Number(parseFloat((now / 1000 - timestamp) / 86400).toFixed(1));
            let deposit = {
                id: dep.id,
                amount: Number(ethers.utils.formatEther(dep.depositAmount)),
                timestamp: timestamp,
                age: age,
                withdrawEligible: (age >= withdrawEligibleAge)
            };
            deposits.push(deposit);

            if (showDeposits) {
                let PS = '';
                if (deposit.withdrawEligible) {
                    PS += '*';
                }
                console.log('\t', deposit.id, ':', Number(deposit.amount.toFixed(2)), '\tage:', age, 'day(s)', PS);
            }
        }
    });

    // console.timeEnd('main');

    // for (const element of ownedDeposits) {
    //     const dep = await contract.depositState(element.toString());
    //     // only care about active deposits
    //     // a deposit is no longer active if it is withdrawn
    //     if (dep.state) {
    //         //const rewards = await contract.getClaimableReward(element.toString());
    //         let timestamp = Number(dep.depositAt.toString());
    //         let age = Number(parseFloat((now / 1000 - timestamp) / 86400).toFixed(1));
    //         let deposit = {
    //             id: element.toString(),
    //             amount: Number(ethers.utils.formatEther(dep.depositAmount)),
    //             timestamp: timestamp,
    //             age: age,
    //             withdrawEligible: (age >= withdrawEligibleAge)
    //             //rewards: Number(ethers.utils.formatEther(rewards))
    //         };
    //         if (showDeposits) {
    //             let PS = '';
    //             if (deposit.withdrawEligible) {
    //                 PS += '*';
    //             }
    //             console.log('\t', deposit.id, ':', Number(deposit.amount.toFixed(2)), '\tage:', age, 'day(s)', PS);
    //         }
    //         deposits.push(deposit);
    //     }
    // };
    //console.log(deposits);

    //console.timeEnd('main');
    return deposits;
}

async function getBalance(address) {
    const rawBalance = await provider.getBalance(address);
    const balance = Number(parseFloat(ethers.utils.formatEther(rawBalance)).toFixed(5));
    return balance;
}

async function balances(index = undefined) {
    const contractBalance = await getBalance(polyContractAddress);
    console.log('Contract balance: ', Number(contractBalance.toFixed(2)),
        `(\$${(contractBalance * price).toFixed(2)})`);

    let totalRewards = 0.0;
    for await (const [key, value] of Object.entries(config[siteName].wallets)) {
        if (index != undefined && config[siteName].wallets[index].address != value.address) {
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
    const contractBalance = await getBalance(polyContractAddress);
    console.log('Contract balance: ', Number(contractBalance.toFixed(2)),
        `(\$${(contractBalance * price).toFixed(2)})`);

    //const now = Date.now().valueOf();

    let totalCapital = 0.0;
    let totalRewards = 0.0;
    let totalEligible = 0.0;
    for await (const [key, value] of Object.entries(config[siteName].wallets)) {
        if (index && config[siteName].wallets[index].address != value.address) {
            continue;
        }
        let balance = await getBalance(value.address);
        console.log();
        console.log(key, 'wallet balance:', Number(balance.toFixed(2)),
            `(\$${(balance * price).toFixed(2)})`);

        if (showDeposits) {
            console.log('Deposits:');
        }
        let deposits = Array.from(await getDeposits(value.address, showDeposits));
        let capital = 0.0;
        let eligible = 0.0;
        //let rewards = 0.0;

        deposits.forEach(element => {
            capital += element.amount;
            if (element.withdrawEligible) {
                eligible += element.amount;
            }
        });
        console.log('Capital:', Number(capital.toFixed(2)),
            `(\$${(capital * price).toFixed(2)})`);
        console.log('Withdraw eligible:', Number(eligible.toFixed(2)),
            `(\$${(eligible * price).toFixed(2)})`,
            `${(eligible / capital * 100).toFixed(2)}%`);

        const rawRewards = await contract.getAllClaimableReward(value.address);
        const rewards = Number(parseFloat(ethers.utils.formatEther(rawRewards)));
        const dailyExpectedWallet = (expectedDailyReturn * capital).toFixed(2);

        console.log('Pending rewards:', Number(rewards.toFixed(2)),
            `(\$${(rewards * price).toFixed(2)})`,
            `${(rewards / dailyExpectedWallet * 100).toFixed(2)}%`);

        console.log('Expected daily:', Number(dailyExpectedWallet),
            `(\$${(dailyExpectedWallet * price).toFixed(2)})`);
        let hourly = (dailyExpectedWallet / 24).toFixed(2);
        console.log('Expected hourly:', Number(hourly),
            `(\$${(hourly * price).toFixed(2)})`);
        console.log('Expected next compound:', Number(dailyExpectedWallet / compoundsPerDay));

        totalCapital += capital;
        totalRewards += rewards;
        totalEligible += eligible;

        //let rewards = await contract.getAllClaimableReward(value.address);
        //console.log(key, ' claimable rewards: ',parseFloat(ethers.utils.formatEther(rewards)).toFixed(2));
    }
    const expectedDailyAmount = (expectedDailyReturn * totalCapital).toFixed(2);

    console.log('\nTotal capital:', Number(totalCapital.toFixed(2)),
        `(\$${(totalCapital * price).toFixed(2)})`);
    console.log('Total withdraw eligible:', Number(totalEligible.toFixed(2)),
        `(\$${(totalEligible * price).toFixed(2)})`,
        `${(totalEligible / totalCapital * 100).toFixed(2)}%`);
    console.log('Total pending rewards:', Number(totalRewards.toFixed(2)),
        `(\$${(totalRewards * price).toFixed(2)})`,
        `${(totalRewards / expectedDailyAmount * 100).toFixed(2)}%`);
    console.log('Total expected daily:', Number(expectedDailyAmount),
        `(\$${(expectedDailyAmount * price).toFixed(2)})`);
    let hourlyAmount = (expectedDailyAmount / 24).toFixed(2);
    console.log('Total expected hourly:', Number(hourlyAmount),
        `(\$${(hourlyAmount * price).toFixed(2)})`);
    console.log('Expected next compound:', Number(expectedDailyAmount / compoundsPerDay));
}

async function withdrawCapital() {
    console.log('Withdraw ALL eligible capital for all wallets on', siteName);
    let capital = 0.0;

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    const prompt = (query) => new Promise((resolve) => rl.question(query, resolve));

    let confirm = false;
    await (async () => {
        try {
            const answer = await prompt('\tAre you sure? (y/N)');
            if (answer == 'y' || answer == 'Y' || answer == 'Yes') {
                confirm = true;
            }
            rl.close();
        } catch (err) {
            console.log(err);
        }
    })();

    //console.log(config[siteName].wallets);
    for await (const [key, value] of Object.entries(config[siteName].wallets)) {
        capital += await withdrawCapitalByKey(value.private);
    }
    console.log('Total withdrawn (including rewards):',
        Number(capital.toFixed(2)),
        `(\$${(capital * price).toFixed(2)})\n`);
}

async function withdrawCapitalByKey(key) {
    const wallet = new ethers.Wallet(key, provider);
    const signedContract = contract.connect(wallet);
    const capital = await withdrawByWallet(wallet, signedContract);

    return capital;
}

async function withdrawByWallet(wallet, signedContract) {
    let capital = 0;
    const deposits = await getDeposits(wallet.address);

    console.log('Withdraw from', wallet.address);
    for (deposit of deposits) {
        if (deposit.withdrawEligible) {
            console.log('Withdraw deposit ID', deposit.id, ':', deposit.amount, symbol);
            capital += await withdrawByDeposit_call(signedContract, deposit.id);
        }
    }
    console.log('Withdrawn from wallet (including rewards):',
        Number(capital.toFixed(2)),
        `(\$${(capital * price).toFixed(2)})\n`);

    return capital;
}

async function withdrawByDeposit(key, depositID) {
    let wallet = new ethers.Wallet(key, provider);
    let signedContract = contract.connect(wallet);

    console.log('Withdraw deposit', depositID, 'from', wallet.address);
    let amount = await withdrawByDeposit_call(signedContract, depositID);
    return amount;
}

async function withdrawByDeposit_call(signedContract, depositID) {
    try {
        let deposit = await contract.depositState(depositID.toString());
        // TODO: deposit itself vs depositID, check age
        let amount = Number(ethers.utils.formatEther(deposit.depositAmount));
        let rawReward = await contract.getClaimableReward(depositID.toString());
        let reward = Number(ethers.utils.formatEther(rawReward));
        let total = amount + reward;
        console.log('Withdrawing deposit of', amount, 'and reward of', reward);

        const tx = await signedContract.withdrawCapital(depositID, {
            gasLimit: gasLimit,
            maxPriorityFeePerGas: maxPriorityFeePerGas,
            maxFeePerGas: maxFeePerGas
            // gasPrice: gasPrice,
        });

        console.log('Successfully withdrew:', total, symbol);
        console.log(`polyScan: ${polyScan}${tx.hash}`)
        console.log('TX Hash:', tx.hash);
        console.log('TX Fee (Gas):', ethers.utils.formatEther(tx.gasLimit * tx.gasPrice), symbol, '\n');

        return amount;
    } catch (err) {
        console.log('Problem with withdraw:', err);
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
        const estimatedGas = await signedContract.estimateGas.claimAllReward();

        const tx = await signedContract.claimAllReward({
            gasLimit: Math.max(gasLimit, estimatedGas),
            maxPriorityFeePerGas: maxPriorityFeePerGas,
            maxFeePerGas: maxFeePerGas
            //gasPrice: gasPrice
        });
        //console.log(tx);

        console.log('Claimed:', rewards, symbol);
        console.log(`polyScan: ${polyScan}${tx.hash}`)
        console.log('TX Hash:', tx.hash);
        console.log('TX Fee (Gas):', ethers.utils.formatEther(tx.gasLimit * tx.gasPrice), symbol);
        console.log('TX maxPriorityFeePerGas:', ethers.utils.formatUnits(tx.maxPriorityFeePerGas, 'gwei'));
        console.log('TX maxFeePerGas:', ethers.utils.formatUnits(tx.maxFeePerGas, 'gwei'));
        console.log('');

        return rewards;
    } catch (err) {
        console.log('Could not claim rewards for', wallet.address, err);
        return;
    }
}

async function claimAllRewards() {
    console.log('Claim rewards for all wallets on', siteName);
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

async function transfer(wallet, recipient, amount) {
    const fromAddress = wallet.address.toString().toLowerCase();
    const toAddress = recipient.toString().toLowerCase();
    try {
        if (fromAddress == toAddress) {
            console.log('Skipping transfer between the same address', wallet.address)
        } else {
            console.log('Transfer from:', fromAddress, 'to', toAddress);
            const preBalance = await getBalance(toAddress);
            const walletSigner = wallet.connect(provider);
            const tx = await walletSigner.sendTransaction({
                from: fromAddress,
                to: toAddress,
                value: String(ethers.utils.parseEther(amount.toString())),
                gasLimit: gasLimit,
                maxPriorityFeePerGas: maxPriorityFeePerGas,
                maxFeePerGas: maxFeePerGas
                //gasPrice: gasPrice
            });

            let balance = 0.0;
            let count = 0;
            let checkBalance = preBalance + amount - config[siteName].leave;
            do {
                await sleep(checkBalanceRetrySeconds * 1000 * count);
                balance = await getBalance(toAddress);
                console.log('Destination balance currently:', balance);
                count += 1;
            } while (balance < checkBalance && count <= checkBalanceRetryAttempts);

            if (count <= checkBalanceRetryAttempts || balance < checkBalance) {
                console.log('Successfully transferred:', amount, symbol);
                console.log(`polyScan: ${polyScan}${tx.hash}`)
                console.log('TX Hash:', tx.hash);
                //console.log('TX Fee (Gas):', ethers.utils.formatEther(tx.gasLimit * tx.gasPrice), symbol, '\n');
            }
        }
    } catch (err) {
        console.log("Could not transfer:", err);
    }
}

async function compoundWallet(key) {
    const wallet = new ethers.Wallet(key, provider);
    const signedContract = contract.connect(wallet);

    console.log('\nCompound wallet:', wallet.address);

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

        if (claimed) {
            // wait for the rewards to show up in the wallet
            let count = 0;
            do {
                await sleep(checkBalanceRetrySeconds * 1000 * count);
                balance = await getBalance(wallet.address);
                console.log('Balance currently:', balance);
                count += 1;
            } while (count <= checkBalanceRetryAttempts && balance < (preBalance + rewards - config[siteName].leave));

            if (count < checkBalanceRetryAttempts || balance < (preBalance + rewards - config[siteName].leave)) {
                let depAmount = (Math.floor(balance) * config[siteName].restake_rate) - config[siteName].leave;
                if (depAmount >= minDeposit) {
                    await deposit(wallet, signedContract, depAmount);
                }

                if (config[siteName].restake_rate < 1) {
                    await transfer(wallet, config[siteName].xfer_wallet, Math.floor(balance) * (1 - config[siteName].restake_rate) - config[siteName].leave);
                }
            } else {
                console.log('Timed out.');
                return;
            }
        } else {
            console.log('Reward claim of', Number(rewards.toFixed(2)), 'failed.');
        }
    } else {
        console.log('Rewards of', Number(rewards.toFixed(2)), 'too low for compounding at this time');
        balance = await getBalance(wallet.address);
        if (wallet.address.toLowerCase() == config[siteName].xfer_wallet.toLowerCase() && balance - config[siteName].leave >= compoundMin) {
            console.log('\t...but existing balance can be deposited');
            await deposit(wallet, signedContract, balance - config[siteName].leave);
        }
    }
}

async function compoundWallets() {
    console.log('Compound all wallets for', siteName);
    for await (const [key, value] of Object.entries(config[siteName].wallets)) {
        await compoundWallet(value.private);
    }
}

async function autoCompound(consolidate = false) {
    console.log('Start autocompounding every', compoundInterval, 'hours');
    setIntervalAsync(async () => { await autoCompoundDriver(consolidate) }, Number(POLLING_INTERVAL) + randomTimeAdjust());
}

async function autoCompoundDriver(consolidate = false) {
    console.log('\nCompouding at', moment().format(momentFormat));

    try {
        await setPrice();
        await setGasFee();
        await compoundWallets();
        if (consolidate) {
            const walletKeys = Object.keys(config[siteName].wallets);
            const walletIndex = walletKeys[walletKeys.length - 1];
            console.log('\nConsolodiating rewards into', config[siteName].wallets[walletIndex].name);
            await depositByKey(config[siteName].wallets[walletIndex].private);
        }
    } catch (err) {
        console.log(err);
    }
}

async function consolidate() {
    await autoCompoundDriver(true);
}

async function run() {
    let daemon = false;
    await setPrice();
    await setGasFee();

    // assumes first arg is "node" and second is this file
    const myArgs = process.argv.slice(2);
    if (myArgs[0]) {
        switch (myArgs[0]) {
            case 'transfer':
            case 'xfer':
                await walletTransfer(myArgs[1], myArgs[2]);
                break;
            case 'with':
            case 'withdraw':
            case 'capital':
            case 'withdrawcapital':
                if (myArgs[1]) {
                    if (myArgs[2]) {
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
                if (myArgs[1]) {
                    await claimRewardsByKey(config[siteName].wallets[myArgs[1]].private);
                } else {
                    await claimAllRewards();
                }
                break;
            case 'comp':
            case 'compound':
                if (myArgs[1]) {
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
                if (myArgs[1]) {
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
                if (myArgs[1]) {
                    await fullBalances(myArgs[1], true);
                } else {
                    await fullBalances(undefined, true);
                }
                break;
            case 'fullbal':
            case 'full':
            case 'fullbalance':
            case 'fullbalances':
                if (myArgs[1]) {
                    await fullBalances(myArgs[1], false);
                } else {
                    await fullBalances();
                }
                break;
            case 'bal':
            case 'balance':
            case 'balances':
            default:
                if (myArgs[1]) {
                    await balances(myArgs[1]);
                } else {
                    await balances();
                }
        }
    }
    if (!daemon) {
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
    if (ms < 0) {
        ms = -ms;
    }
    fn().then(() => {
        setTimeout(() => setIntervalAsync(fn, ms), ms);
    });
};

function randomTimeAdjust() {
    const random_min_buffer = 4;
    let amount = Math.random() * 1000 * 60 * random_min_buffer;
    if (Math.random() < 0.5) {
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



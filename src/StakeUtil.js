"use strict";

import { BigNumber, ethers } from 'ethers';
import got from 'got';
import moment from 'moment';
import readline from 'readline';

export default function StakeUtil(params) {
    const expectedDailyReturn = 0.015; // rate in decimal
    const withdrawEligibleAge = 28; // days

    const walletConfig = params.walletConfig ? params.walletConfig : {};
    if (Object.keys(walletConfig).length === 0) {
        throw 'Must specify 1 or more wallets in "walletConfig" ({label: {name: name, address: address, private: private key}, label2: {...}})';
    }
    if (!params.siteName) {
        throw 'Must specify "siteName" in params';
    }
    const xferWallet = params.xferWallet ? params.xferWallet : undefined;
    const siteName = params.siteName ? params.siteName : 'StableFund';
    if (!params.symbol) {
        throw 'Must specify "symbol" in params';
    }
    const symbol = params.symbol;
    if (!params.contractAddress) {
        throw 'Must specify "contractAddress" in params';
    }
    const contractAddress = params.contractAddress;
    if (!params.abi) {
        throw 'Must specify "abi" in params';
    }
    const abi = params.abi;
    let JsonProvider = params.JsonProvider ? new ethers.providers.JsonRpcProvider(params.JsonProvider) : undefined;
    let WSSProvider = params.WSSProvider ? new ethers.providers.WebSocketProvider(params.WSSProvider) : undefined;
    let provider = undefined;
    if (WSSProvider) {
        provider = WSSProvider;
    } else if (JsonProvider) {
        provider = JsonProvider;
    } else {
        throw 'No provider specified in params, specify either JsonProvider or WSSProvider address';
    }
    const contract = new ethers.Contract(contractAddress, abi, provider);
    const tokenAddress = params.tokenAddress ? params.tokenAddress : undefined;
    const tokenContract = tokenAddress ? new ethers.Contract(tokenAddress, abi, provider) : undefined;
    const scanURL = params.scanURL ? params.scanURL : undefined;
    const gasStation = params.gasStation ? params.gasStation : undefined;
    const gasPriority = params.gasPriority ? params.gasPriority : 'safeLow';  // safeLow, standard, fast for Polygon
    let gasPremium = params.gasPremium ? params.gasPremium : 0.0;
    let gasLimit = params.gasLimit ? ethers.BigNumber.from(params.gasLimit) : ethers.BigNumber.from(8000000);
    // for Polygon network
    let maxFeePerGas = params.maxFeePerGas ? ethers.utils.parseUnits(params.maxFeePerGas) : ethers.utils.parseUnits("30","gwei");
    let maxPriorityFeePerGas = params.maxPriorityFeePerGas ? ethers.utils.parseUnits(params.maxPriorityFeePerGas) : ethers.utils.parseUnits("40","gwei");
    const maxGasFeeForAuto = params.maxGasFeeForAuto ? ethers.utils.parseUnits(params.maxGasFeeForAuto.toString(),'gwei') : ethers.utils.parseUnits("80","gwei");
    // for BSC network
    let gasPrice = params.gasPrice ? ethers.BigNumber.from(params.gasPrice) : ethers.BigNumber.from(20000000);
    const momentFormat = params.momentFormat ? params.momentFormat : 'MMM-DD-YYYY hh:mm:ss A +UTC';
    const compoundsPerDay = params.compoundsPerDay ? params.compoundsPerDay : 1;
    const compoundMin = params.compoundMin ? params.compoundMin : 0.0;
    const compoundInterval = 24 / compoundsPerDay;
    const amountToLeave = params.amountToLeave ? params.amountToLeave : 2.0;  // should be non-zero or transactions won't go through
    const restakeRate = params.hasOwnProperty('restakeRate') ? params.restakeRate : 1.0;
    const minDeposit = params.hasOwnProperty('minDeposit') ? params.minDeposit : 10;
    const checkBalanceRetrySeconds = params.checkBalanceRetrySeconds ? params.checkBalanceRetrySeconds : 5;
    const checkBalanceRetryAttempts = params.checkBalanceRetryAttempts ? params.checkBalanceRetryAttempts : 100;
    const CMCAPIKey = params.CMCAPIKey ? params.CMCAPIKey : undefined;
    const moralisKey = params.moralisKey ? params.moralisKey : undefined;
    const coinAPIKey = params.coinAPIKey ? params.coinAPIKey : undefined;

    let price = 0.0;

    const hoursToMS = (hrs) => {
        return hrs * 60 * 60 * 1000;
    }
    const pollingInterval = hoursToMS(compoundInterval);

    const sleep = async (ms) => {
        return new Promise((resolve) => {
            setTimeout(resolve, ms);
        });
    }

    // CoinMarketCap price
    const setPrice = async (_symbol = undefined, convert = 'USD') => {
        if (!_symbol) {
            _symbol = symbol;
        }
        if (CMCAPIKey) {
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
                            'X-CMC_PRO_API_KEY': CMCAPIKey
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
    }
    const getPrice = () => { return price; }


    // avoid underpriced transaction by getting current gas prices
    // for replanting and harvesting transactions
    const setGasFee = async () => {
        try {
            if (gasStation) {
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

                if (gasPremium != 0) {
                    let premium = BigNumber.from(gasPremium + 100);
                    maxPriorityFeePerGas = maxPriorityFeePerGas.mul(premium).div(BigNumber.from(100));
                    maxFeePerGas = maxFeePerGas.mul(premium).div(BigNumber.from(100));
                }

                console.log('maxPriorityFeePerGas:', ethers.utils.formatUnits(maxPriorityFeePerGas, 'gwei'), 'gwei');
                console.log('maxFeePerGas:', ethers.utils.formatUnits(maxFeePerGas, 'gwei'), 'gwei');
            }
        } catch (err) {
            console.log("Error getting gas fee", err);
        }
    }

    // Read balances
    const getDepositState = async (depositID) => {
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

    const fetchDepositState = async (id) => {
        let dep = await contract.depositState(id);
        return {
            id: id,
            depositAt: dep.depositAt,
            depositAmount: dep.depositAmount,
            state: dep.state
        }
    }

    const getDeposits = async (address, showDeposits = false) => {
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

        return deposits;
    }

    const getBalance = async (address) => {
        const rawBalance = await provider.getBalance(address);
        const balance = Number(parseFloat(ethers.utils.formatEther(rawBalance)).toFixed(5));
        return balance;
    }

    const balances = async (label = undefined) => {
        const contractBalance = await getBalance(contractAddress);
        console.log('Contract balance: ', Number(contractBalance.toFixed(2)),
            `(\$${(contractBalance * price).toFixed(2)})`);

        let totalRewards = 0.0;
        for await (const [key, value] of Object.entries(walletConfig)) {
            if (label !== undefined && walletConfig[label] && walletConfig[label].address !== value.address) {
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

    const fullBalances = async (label = undefined, showDeposits = false) => {
        const contractBalance = await getBalance(contractAddress);
        console.log('Contract balance: ', Number(contractBalance.toFixed(2)),
            `(\$${(contractBalance * price).toFixed(2)})`);

        let totalCapital = 0.0;
        let totalRewards = 0.0;
        let totalEligible = 0.0;
        for await (const [key, value] of Object.entries(walletConfig)) {
            if (label && walletConfig[label] && walletConfig[label].address !== value.address) {
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

    // Transfer funds
    const walletTransfer = async (fromLabel, toLabel) => {
        const fromWallet = new ethers.Wallet(walletConfig[fromLabel].private, provider);
        //const toWallet = new ethers.Wallet(walletConfig[toLabel].private, provider);
        const rawBalance = await provider.getBalance(fromWallet.address);
        const myBalance = Number(parseFloat(ethers.utils.formatEther(rawBalance)).toFixed(3));

        const xferAmount = Math.floor(myBalance) - amountToLeave;

        console.log('Wallet transfer of:', xferAmount);

        await transfer(fromWallet, walletConfig[toLabel].address, xferAmount);
    }

    const transfer = async (wallet, recipient, amount) => {
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
                console.log('TX Hash:', tx.hash);

                let balance = 0.0;
                let count = 0;
                let checkBalance = preBalance + amount - amountToLeave;  // in case a lot used in xfer
                do {
                    await sleep(checkBalanceRetrySeconds * 1000);
                    balance = await getBalance(toAddress);
                    count += 1;
                    console.log(count, 'Destination balance currently:', balance);
                } while (balance < checkBalance && count <= checkBalanceRetryAttempts);

                if (balance >= checkBalance) {
                    console.log('Successfully transferred:', amount, symbol);
                    if (scanURL) {
                        console.log(`scan: ${scanURL}${tx.hash}`);
                    }
                    //console.log('TX Fee (Gas):', ethers.utils.formatEther(tx.gasLimit * tx.gasPrice), symbol, '\n');
                }
            }
        } catch (err) {
            console.log("Could not transfer:", err);
        }
    }

    // Perform deposits
    const doAllDeposits = async () => {
        console.log('Deposit funds from all wallets for', siteName);
        for await (const [key, value] of Object.entries(walletsConfig)) {
            await depositByKey(value.private);
        }
    }

    const depositByKey = async (key) => {
        console.log(key);
        const wallet = new ethers.Wallet(key, provider);
        const signedContract = contract.connect(wallet);
        await deposit(wallet, signedContract);
    }

    const deposit = async (wallet, signedContract, amount = 0.0) => {
        console.log('\nDeposit from:', wallet.address);

        let xferAmount = 0.0;
        if (amount <= 0.0) {
            let rawBalance = await provider.getBalance(wallet.address);
            let myBalance = Number(parseFloat(ethers.utils.formatEther(rawBalance)).toFixed(3));
            console.log('Wallet balance:', myBalance);

            xferAmount = Math.floor(myBalance) - amountToLeave;
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
            console.log('TX Hash:', tx.hash);

            let balance = 0.0;
            let count = 0;
            do {
                await sleep(checkBalanceRetrySeconds * 1000);
                balance = await getBalance(wallet.address);
                count += 1;
                console.log(count, 'Destination balance currently:', balance);
            } while (balance == preBalance && count <= checkBalanceRetryAttempts);

            // console.log('balance',balance);
            // console.log('preBalance',preBalance);
            // console.log('xferAmount',xferAmount);
            // console.log(balance > (preBalance - xferAmount))
            if (balance > (preBalance - xferAmount)) {
                console.log('Error with deposit');
                const errTxn = await provider.getTransaction(tx.hash);
                try {
                    console.log(errTxn);
                    // let code = await provider.call(errTxn, errTxn.blockNumber);
                    // console.log(code);
                } catch (err) {
                    console.log(err);
                    console.log(err.data.toString());
                }
            } else {
                console.log('Deposited:', xferAmount, symbol);
                if (scanURL) {
                    console.log(`Scan: ${scanURL}${tx.hash}`);
                }
                
                //console.log('TX Fee (Gas):', ethers.utils.formatEther(tx.gasLimit * tx.gasPrice), symbol, '\n');
            }
        } else {
            console.log('Tranfer amount too low.');
        }

        console.log('');
    }

    // Claim rewards
    const claimRewardsByKey = async (key) => {
        const wallet = new ethers.Wallet(key, provider);
        const signedContract = contract.connect(wallet);
        const rewards = await claimRewardsByWallet(wallet, signedContract);

        return rewards;
    }

    const claimRewardsByWallet = async (wallet, signedContract, rewards = undefined) => {
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
            console.log('TX Hash:', tx.hash);

            console.log('Claimed:', rewards, symbol);
            if (scanURL) {
                console.log(`scan: ${scanURL}${tx.hash}`);
            }
            
            //console.log('TX Fee (Gas):', ethers.utils.formatEther(tx.gasLimit * tx.gasPrice), symbol);
            console.log('TX maxPriorityFeePerGas:', ethers.utils.formatUnits(tx.maxPriorityFeePerGas, 'gwei'));
            console.log('TX maxFeePerGas:', ethers.utils.formatUnits(tx.maxFeePerGas, 'gwei'));
            console.log('');

            return rewards;
        } catch (err) {
            console.log('Could not claim rewards for', wallet.address, err);
            return;
        }
    }

    const claimAllRewards = async () => {
        console.log('Claim rewards for all wallets on', siteName);
        for await (const [key, value] of Object.entries(walletConfig)) {
            await claimRewardsByKey(value.private);
        }
    }

    // Perform withdrawls
    const withdrawCapital = async () => {
        console.log('Withdraw ALL eligible capital for all wallets on', siteName);
        let capital = 0.0;

        // Prompt the user if you want to actually withdraw all eligible funds
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
        for await (const [key, value] of Object.entries(walletConfig)) {
            capital += await withdrawCapitalByKey(value.private);
        }
        console.log('Total withdrawn (including rewards):',
            Number(capital.toFixed(2)),
            `(\$${(capital * price).toFixed(2)})\n`);
    }

    const withdrawCapitalByLabel = async (label) => {
        let key = walletConfig[label].private;
        return withdrawCapitalByKey(key);
    }

    const withdrawCapitalByKey = async (key) => {
        const wallet = new ethers.Wallet(key, provider);
        const signedContract = contract.connect(wallet);
        const capital = await withdrawByWallet(wallet, signedContract);

        return capital;
    }

    const withdrawCapitalByWallet = async (wallet, signedContract) => {
        let capital = 0;
        const deposits = await getDeposits(wallet.address);

        console.log('Withdraw from', wallet.address);
        for (deposit of deposits) {
            if (deposit.withdrawEligible) {
                console.log('Withdraw deposit ID', deposit.id, ':', deposit.amount, symbol);
                capital += await withdrawByDeposit_call(wallet, signedContract, deposit.id);
            }
        }
        console.log('Withdrawn from wallet (including rewards):',
            Number(capital.toFixed(2)),
            `(\$${(capital * price).toFixed(2)})\n`);

        return capital;
    }

    const withdrawCapitalByDeposit = async (key, depositID) => {
        let wallet = new ethers.Wallet(key, provider);
        let signedContract = contract.connect(wallet);

        console.log('Withdraw deposit', depositID, 'from', wallet.address);
        let amount = await withdrawByDeposit_call(wallet, signedContract, depositID);
        return amount;
    }

    const withdrawByDeposit_call = async (wallet, signedContract, depositID) => {
        try {
            let deposit = await contract.depositState(depositID.toString());
            // TODO: deposit itself vs depositID, check age
            let amount = Number(ethers.utils.formatEther(deposit.depositAmount));
            let rawReward = await contract.getClaimableReward(depositID.toString());
            let reward = Number(ethers.utils.formatEther(rawReward));
            let total = amount + reward;
            console.log('Withdrawing deposit of', amount, 'and reward of', reward);
            const preBalance = await getBalance(wallet.address);
            let balance = 0.0;

            const tx = await signedContract.withdrawCapital(depositID, {
                gasLimit: gasLimit,
                maxPriorityFeePerGas: maxPriorityFeePerGas,
                maxFeePerGas: maxFeePerGas
                // gasPrice: gasPrice,
            });
            console.log('TX Hash:', tx.hash);

            // wait for the rewards to show up in the wallet
            let count = 0;
            do {
                await sleep(checkBalanceRetrySeconds * 1000);
                balance = await getBalance(wallet.address);
                count += 1;
                console.log(count, 'Balance currently:', balance);
            } while (count <= checkBalanceRetryAttempts && balance < (preBalance + total - amountToLeave));

            if (balance >= (preBalance + total - amountToLeave)) {
                console.log('Successfully withdrew:', total, symbol);
                if (scanURL) {
                    console.log(`scan: ${scanURL}${tx.hash}`);
                }
                //console.log('TX Fee (Gas):', ethers.utils.formatEther(tx.gasLimit * tx.gasPrice), symbol, '\n');

                if (xferWallet && xferWallet != wallet.address) {
                    await transfer(wallet, xferWallet, balance - amountToLeave);
                }
            }

            return amount;
        } catch (err) {
            console.log('Problem with withdraw:', err);
            return false;
        }
    }

    // Compounding
    const compoundWallet = async (key) => {
        const wallet = new ethers.Wallet(key, provider);
        const signedContract = contract.connect(wallet);
    
        console.log('Compound wallet:', wallet.address);
    
        const rawRewards = await contract.getAllClaimableReward(wallet.address);
        //console.log('rawRewards',rawRewards);
        let rewards = Number(parseFloat(ethers.utils.formatEther(rawRewards)));
        let balance = 0;
        //console.log('rewards',rewards);
        if (rewards - amountToLeave >= compoundMin) {
            const preBalance = await getBalance(wallet.address);
            //console.log('prebalance',preBalance);
            const claimed = await claimRewardsByWallet(wallet, signedContract, rewards);
            //console.log('after claiming rewards',claimed);
    
            if (claimed) {
                // wait for the rewards to show up in the wallet
                let count = 0;
                do {
                    await sleep(checkBalanceRetrySeconds * 1000);
                    balance = await getBalance(wallet.address);
                    console.log('Balance currently:', balance);
                    count += 1;
                } while (count <= checkBalanceRetryAttempts && balance < (preBalance + rewards - amountToLeave));
    
                if (balance >= (preBalance + rewards - amountToLeave)) {
                    let depAmount = (Math.floor(balance) * restakeRate) - amountToLeave;
                    if (depAmount >= minDeposit) {
                        await deposit(wallet, signedContract, depAmount);
                    }
    
                    if (restakeRate < 1) {
                        await transfer(wallet, xferWallet, Math.floor(balance) * (1 - restakeRate) - amountToLeave);
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
            if (wallet.address.toLowerCase() == xferWallet.toLowerCase() && (balance - amountToLeave) >= compoundMin) {
                console.log('\t...but existing balance can be deposited');
                await deposit(wallet, signedContract, balance - amountToLeave);
            }
        }
    }
    
    const compoundWallets = async () => {
        console.log('Compound all wallets for', siteName);
        for await (const [key, value] of Object.entries(walletConfig)) {
            console.log('\n',key);
            await compoundWallet(value.private);
        }
    }
    
    const autoCompound = async (consolidate = false) => {
        console.log('Start autocompounding every', compoundInterval, 'hours');
        setIntervalAsync(async () => { await autoCompoundDriver(consolidate) }, Number(pollingInterval));
    }
    
    const autoCompoundDriver = async (consolidate = false) => {
        console.log('\nCompouding at', moment().format(momentFormat));
    
        try {
            await setPrice();
            await setGasFee();
            if(maxFeePerGas.gt(maxGasFeeForAuto)) {
                console.log('Gas fees currently too high');
                return;
            } else {
                await compoundWallets();
                if (consolidate) {
                    const walletKeys = Object.keys(walletConfig);
                    const walletIndex = walletKeys[walletKeys.length - 1];
                    console.log('\nConsolodiating rewards into', walletConfig[walletIndex].name);
                    await depositByKey(walletConfig[walletIndex].private);
                }
            }
        } catch (err) {
            console.log(err);
        }
    }
    
    const consolidate = async () => {
        await autoCompoundDriver(true);
    }

    // Evaluate arguments and run functions
    const run = async (args) => {
        let daemon = false;
        await setPrice();
        await setGasFee();

        // assumes first arg is "node" and second is this file
        const myArgs = args.slice(0);
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
                            await withdrawCapitalByDeposit(walletConfig[myArgs[1]].private, myArgs[2]);
                        } else {
                            await withdrawCapitalByKey(walletConfig[myArgs[1]].private);
                        }
                    } else {
                        await withdrawCapital();
                    }
                    break;
                case 'claim':
                case 'claimrewards':
                case 'rewards':
                    if (myArgs[1]) {
                        await claimRewardsByKey(walletConfig[myArgs[1]].private);
                    } else {
                        await claimAllRewards();
                    }
                    break;
                case 'comp':
                case 'compound':
                    if (myArgs[1]) {
                        await compoundWallet(walletConfig[myArgs[1]].private);
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
                        await depositByKey(walletConfig[myArgs[1]].private)
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

    return {
        expectedDailyReturn,
        withdrawEligibleAge,
        contract,
        tokenContract,
        provider,
        setPrice,
        getPrice,
        setGasFee,
        getDepositState,
        getDeposits,
        transfer,
        walletTransfer,
        balances,
        getBalance,
        fullBalances,
        doAllDeposits,
        depositByKey,
        deposit,
        claimRewardsByKey,
        claimRewardsByWallet,
        claimAllRewards,
        withdrawCapital,
        withdrawCapitalByKey,
        withdrawCapitalByLabel,
        withdrawCapitalByWallet,
        withdrawCapitalByDeposit,
        compoundWallet,
        compoundWallets,
        autoCompound,
        consolidate,
        run
    }
}


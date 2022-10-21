"use strict";

import { BigNumber, ethers, utils } from 'ethers';
import got from 'got';
import moment from 'moment';
//import { config } from 'process';
import readline from 'readline';
import { abi20 } from "./abi/bep20.js";
import { LedgerSigner } from "@ethersproject/hardware-wallets";

export default function StakeUtil(params) {
    const expectedDailyReturn = 0.015; // rate in decimal
    const withdrawEligibleAge = 28; // days

    const walletConfig = params.walletConfig ? params.walletConfig : {};
    if (Object.keys(walletConfig).length === 0) {
        throw 'Must specify 1 or more wallets in "walletConfig" ({index: {name: name, address: address, private: private key}, index2: {...}})';
    }
    for (const [key, value] of Object.entries(walletConfig)) {
        console.log(`${key}: ${value.name}, ${value.address}`);
    }
    if (!params.siteName) {
        throw 'Must specify "siteName" in params';
    }
    const xferWallet = params.xferWallet ? params.xferWallet : undefined;
    const siteName = params.siteName ? params.siteName : 'StableFund';

    if (!params.blockchain) {
        throw 'Must specifcy a "blockchain" in params';
    }
    const blockchain = params.blockchain;

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
    const tokenContract = tokenAddress ? new ethers.Contract(tokenAddress, abi20, provider) : undefined;
    const scanURL = params.scanURL ? params.scanURL : undefined;
    let gasStation = params.gasStation ? params.gasStation : undefined;
    const gasPriority = params.gasPriority ? params.gasPriority : 'safeLow';  // safeLow, standard, fast for Polygon
    let gasPremium = params.gasPremium ? params.gasPremium : 0.0;
    let gasLimit = params.gasLimit ? ethers.BigNumber.from(params.gasLimit) : ethers.BigNumber.from(8000000);
    // for Polygon network
    let maxFeePerGas = params.maxFeePerGas ? ethers.utils.parseUnits(params.maxFeePerGas) : ethers.utils.parseUnits("30", "gwei");
    let maxPriorityFeePerGas = params.maxPriorityFeePerGas ? ethers.utils.parseUnits(params.maxPriorityFeePerGas) : ethers.utils.parseUnits("40", "gwei");
    const maxGasFeeForAuto = params.maxGasFeeForAuto ? ethers.utils.parseUnits(params.maxGasFeeForAuto.toString(), 'gwei') : ethers.utils.parseUnits("200", "gwei");
    // for BSC network
    let gasPrice = params.gasPrice ? ethers.BigNumber.from(params.gasPrice) : ethers.BigNumber.from(20000000);
    const momentFormat = params.momentFormat ? params.momentFormat : 'MMM-DD-YYYY hh:mm:ss A +UTC';
    const compoundsPerDay = params.compoundsPerDay ? params.compoundsPerDay : 1;
    const compoundMin = params.compoundMin ? params.compoundMin : 0.0;
    const compoundInterval = 24 / compoundsPerDay;
    const amountToLeave = params.amountToLeave ? params.amountToLeave : 2.0;  // should be non-zero or transactions won't go through
    const restakeRate = params.hasOwnProperty('restakeRate') ? params.restakeRate : 1.0;
    const minDeposit = params.hasOwnProperty('minDeposit') ? params.minDeposit : 10;
    //const checkBalanceRetrySeconds = params.checkBalanceRetrySeconds ? params.checkBalanceRetrySeconds : 5;
    //const checkBalanceRetryAttempts = params.checkBalanceRetryAttempts ? params.checkBalanceRetryAttempts : 100;
    const CMCAPIKey = params.CMCAPIKey ? params.CMCAPIKey : undefined;
    const moralisKey = params.moralisKey ? params.moralisKey : undefined;
    const coinAPIKey = params.coinAPIKey ? params.coinAPIKey : undefined;
    const approveEveryTxn = params.approveEveryTxn ? params.approveEveryTxn : false;

    let depositCounts = {};
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

    const setIntervalAsync = (fn, ms) => {
        //console.log('setInterval',ms);
        if (ms < 0) {
            ms = -ms;
        }
        fn().then(() => {
            setTimeout(() => setIntervalAsync(fn, ms), ms);
        });
    };

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
                console.log("Current", _symbol, "price:", `\$${response.data[0].quote['USD'].price.toFixed(2)}`);
                price = Number(response.data[0].quote['USD'].price);
                return price;
            } catch (err) {
                console.log(err);
                return false;
            }
        }
    }
    const getPrice = () => { return price; }

    const normNetwork = () => {
        switch (blockchain.toLowerCase()) {
            case "polygon":
            case "matic":
                return "polygon";
                break;
            case "bsc":
            case "bnb":
            case "busd":
            case "binance":
                return "bsc";
                break;
            default:
                return "";
                break;
        }
    }

    // avoid underpriced transaction by getting current gas prices
    // for replanting and harvesting transactions
    const setGasFee = async () => {
        switch (normNetwork()) {
            case "polygon":
                await setGasFeePolygon();
                break;
            case "bsc":
                await setGasFeeOwlracle();
                break;
        }
    }

    const setGasFeeOwlracle = async () => {
        try {
            gasPrice = await provider.getGasPrice();
            //console.log('Initial gas price:', gasPrice.toString());
            const data = await got(gasStation).json();

            let gasPriceB = ethers.utils.parseUnits(data.speeds[2].gasPrice.toString(), 'gwei');

            if (gasPriceB.gt(gasPrice)) {
                gasPrice = gasPriceB;
                console.log('Use gas station value:', gasPrice.toString());
            }
            if (gasPremium != 0) {
                let premium = ethers.BigNumber.from(gasPremium + 100);
                gasPrice = gasPrice.mul(premium).div(ethers.BigNumber.from(100));
                console.log('Add premium, now:', gasPrice.toString());
            }
        } catch (err) {
            console.log("Error getting gas fee", err);
        }
    }

    const setGasFeePolygon = async () => {
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

    const txnPrice = (limit = undefined) => {
        let options = {};
        if (limit) {
            options.gasLimit = limit;
        } else {
            options.gasLimit = gasLimit;
        }
        switch (normNetwork()) {
            case "polygon":
                options.maxPriorityFeePerGas = maxPriorityFeePerGas;
                options.maxFeePerGas = maxFeePerGas;
                break;
            case "bsc":
                options.gasPrice = gasPrice;
                break;
            default:
                throw new Error("No blockchain network set");
        }
        return options;
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

        depositCounts[address] = Object.keys(ownedDeposits).length;
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
        let rawBalance = undefined;
        if (tokenContract) {
            rawBalance = await tokenContract.balanceOf(address);
        } else {
            rawBalance = await provider.getBalance(address);
        }
        const balance = Number(parseFloat(ethers.utils.formatEther(rawBalance)).toFixed(5));
        return balance;
    }

    const numberWithCommas = (num) => {
        return num.toFixed(2).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }

    const balances = async (index = undefined) => {
        const contractBalance = await getBalance(contractAddress);
        console.log('Contract balance: ', Number(contractBalance.toFixed(2)),
            `(\$${numberWithCommas(contractBalance * price)})`);

        let totalRewards = 0.0;
        for await (const [key, value] of Object.entries(walletConfig)) {
            if (index !== undefined && walletConfig[index] && walletConfig[index].address !== value.address) {
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

    const fullBalances = async (index = undefined, showDeposits = false) => {
        const contractBalance = await getBalance(contractAddress);
        console.log('Contract balance: ', Number(contractBalance.toFixed(2)),
            `(\$${numberWithCommas(contractBalance * price)})`);

        let totalCapital = 0.0;
        let totalRewards = 0.0;
        let totalEligible = 0.0;
        for await (const [key, value] of Object.entries(walletConfig)) {
            if (index && walletConfig[index] && walletConfig[index].address !== value.address) {
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
            console.log(`Number of deposits, active/total: ${deposits.length}/${depositCounts[value.address]}`);
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
    const walletTransfer = async (fromIndex, toIndex) => {
        const fromWallet = new ethers.Wallet(walletConfig[fromIndex].private, provider);
        let toAddress = undefined;
        if (walletConfig[toIndex]) {
            toAddress = walletConfig[toIndex].address;
        } else {
            toAddress = toIndex;
        }
        //const toWallet = new ethers.Wallet(walletConfig[toIndex].private, provider);
        //const rawBalance = await provider.getBalance(fromWallet.address);
        //const myBalance = Number(parseFloat(ethers.utils.formatEther(rawBalance)).toFixed(3));
        const myBalance = await getBalance(fromWallet.address)

        const xferAmount = Math.floor(myBalance) - amountToLeave;

        console.log('Wallet transfer of:', xferAmount);

        await transfer(fromWallet, toAddress, xferAmount);
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
                let signedToken = undefined;
                if (tokenContract) {
                    signedToken = tokenContract.connect(wallet);
                }

                let options = txnPrice();

                let tx = undefined;
                const xferAmount = String(ethers.utils.parseEther(amount.toString()));
                if (signedToken) {
                    tx = await signedToken.transfer(toAddress, xferAmount, options);
                } else {
                    options.from = fromAddress;
                    options.to = toAddress;
                    options.value = xferAmount;
                    tx = await walletSigner.sendTransaction(options);
                }

                console.log('TX Hash:', tx.hash);

                await tx.wait();
                console.log('Transferred:', amount, symbol);

            }
        } catch (err) {
            console.log("Could not transfer:", err);
        }
    }

    // Perform deposits
    async function approveByIndex(index, amount) {
        const key = walletConfig[index].private;
        const wallet = new ethers.Wallet(key, provider);
        const signedToken = tokenContract.connect(wallet);
        await approve(signedToken, amount);
    }

    const approve = async (signedToken, amount) => {
        if (signedToken) {
            await setGasFee();
            let parsedAmount = undefined;
            if (amount == 'max' || amount == 'unlimited') {
                parsedAmount = '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
            } else {
                parsedAmount = ethers.utils.parseEther(amount);
            }
            const approval = await signedToken.approve(contractAddress, parsedAmount, {
                gasPrice: gasPrice,
                gasLimit: gasLimit
            });
            console.log('Approved transfer of', amount, symbol);
            console.log(`Explorer: ${scanURL}${approval.hash}`);
            await sleep(1000);
        }
    }

    const doAllDeposits = async () => {
        console.log('Deposit funds from all wallets for', siteName);
        for await (const [key, value] of Object.entries(walletConfig)) {
            await depositByKey(value.private);
        }
    }

    const depositByKey = async (key) => {
        console.log(key);
        const wallet = new ethers.Wallet(key, provider);
        const signedContract = contract.connect(wallet);
        let signedToken = undefined;
        if (tokenContract) {
            signedToken = tokenContract.connect(wallet);
        }
        await deposit(wallet, signedContract, 0, signedToken);
    }

    const deposit = async (wallet, signedContract, amount = 0.0, signedToken = undefined) => {
        console.log('\nDeposit from:', wallet.address);

        let xferAmount = 0.0;

        let myBalance = await getBalance(wallet.address);
        console.log('Wallet balance:', myBalance);

        if (amount <= 0.0) {
            xferAmount = Math.floor(myBalance) - amountToLeave;
        } else {
            xferAmount = amount;
        }

        console.log('Deposit amount:', xferAmount);

        if (xferAmount > minDeposit) {
            try {
                const depositValue = String(ethers.utils.parseEther(xferAmount.toString()));
                let estimatedGas, useGasLimit, options, tx = undefined;
                
                if (approveEveryTxn) {
                    await approve(signedToken, xferAmount);
                }

                if (tokenContract) {
                    estimatedGas = await signedContract.estimateGas.deposit(depositValue);
                    useGasLimit = gasLimit;
                    if(estimatedGas.toString() > gasLimit.toString()) {
                        useGasLimit = estimatedGas;
                    }
                    options = txnPrice(useGasLimit);
                    // the BUSD contract takes the deposit amount as a parameter
                    tx = await signedContract.deposit(depositValue, options);
                } else {
                    estimatedGas = await signedContract.estimateGas.deposit({ value: depositValue });
                    useGasLimit = gasLimit;
                    if(estimatedGas.toString() > gasLimit.toString()) {
                        useGasLimit = estimatedGas;
                    }
                    options = txnPrice(useGasLimit);
                    // the native token (MATIC and BNB) contracts take the amount value in the msg/options object
                    options.value = depositValue;
                    tx = await signedContract.deposit(options);
                }
                console.log('TX Hash:', tx.hash);

                await tx.wait();
                console.log('Deposited:', xferAmount, symbol);
            } catch (err) {
                console.log('Error depositing:', err);
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
            console.log('\nClaim rewards for ', wallet.address);
            if (!rewards) {
                const rawRewards = await contract.getAllClaimableReward(wallet.address);
                rewards = Number(parseFloat(ethers.utils.formatEther(rawRewards)));
            }

            const preBalance = await getBalance(wallet.address);
            //console.log('claim',rewards.toString());
            if (rewards < compoundMin) {
                console.log(`Rewards too low to claim for now: ${rewards} vs. min. required of ${compoundMin}`);
                return 0;
            }
            const estimatedGas = await signedContract.estimateGas.claimAllReward();

            let options = txnPrice(estimatedGas.mul(12).div(10));

            const tx = await signedContract.claimAllReward(options);
            //console.log(tx);
            console.log('TX Hash:', tx.hash);

            await tx.wait();

            console.log('Claimed:', rewards, symbol);
            if (scanURL) {
                console.log(`scan: ${scanURL}${tx.hash}`);
            }

            //console.log('TX Fee (Gas):', ethers.utils.formatEther(tx.gasLimit * tx.gasPrice), symbol);
            //console.log('TX maxPriorityFeePerGas:', ethers.utils.formatUnits(tx.maxPriorityFeePerGas, 'gwei'));
            //console.log('TX maxFeePerGas:', ethers.utils.formatUnits(tx.maxFeePerGas, 'gwei'));
            console.log('');

            // if (wallet.address.toLowerCase() != xferWallet.toLowerCase() && rewards > amountToLeave) {
            //     let balance = await getBalance(wallet.address);
            //     await transfer(wallet, xferWallet, balance - amountToLeave);
            // }

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

        if (confirm) {
            for await (const [key, value] of Object.entries(walletConfig)) {
                capital += await withdrawCapitalByKey(value.private);
            }
            console.log('Total withdrawn (including rewards):',
                Number(capital.toFixed(2)),
                `(\$${(capital * price).toFixed(2)})\n`);
        }
    }

    const withdrawCapitalByIndex = async (index) => {
        let key = walletConfig[index].private;
        return withdrawCapitalByKey(key);
    }

    const withdrawCapitalByKey = async (key) => {
        const wallet = new ethers.Wallet(key, provider);
        const signedContract = contract.connect(wallet);
        //const signedContract = new ethers.Contract(contractAddress, abi, watchSigner);
        let signedToken = undefined;
        if (tokenContract) {
            signedToken = tokenContract.connect(wallet);
        }
        const capital = await withdrawCapitalByWallet(wallet, signedContract, signedToken);

        return capital;
    }

    const withdrawCapitalByWallet = async (wallet, signedContract, signedToken = undefined) => {
        let capital = 0;
        const deposits = await getDeposits(wallet.address);

        console.log('Withdraw from', wallet.address);
        for (const deposit of deposits) {
            if (deposit.withdrawEligible) {
                console.log('Withdraw deposit ID', deposit.id, ':', deposit.amount, symbol);
                capital += await withdrawByDeposit_call(wallet, signedContract, deposit.id, signedToken);
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
        let signedToken;
        if(tokenContract) {
            signedToken = tokenContract.connect(wallet);
        }

        console.log('Withdraw deposit', depositID, 'from', wallet.address);
        let amount = await withdrawByDeposit_call(wallet, signedContract, depositID, signedToken);
        return amount;
    }

    const withdrawByDeposit_call = async (wallet, signedContract, depositID, signedToken = undefined) => {
        try {
            let deposit = await contract.depositState(depositID.toString());
            // TODO: deposit itself vs depositID, check age
            let amount = Number(ethers.utils.formatEther(deposit.depositAmount));
            let rawReward = 0;
            if (tokenContract) {
                rawReward = await contract.getAllClaimableReward(wallet.address);
            } else {
                rawReward = await contract.getClaimableReward(depositID.toString());
            }
            let reward = Number(ethers.utils.formatEther(rawReward));
            let total = amount + reward;
            console.log('Withdrawing deposit of', amount, 'and reward of', reward);
            const preBalance = await getBalance(wallet.address);
            let balance = 0.0;

            let options = txnPrice();
            const tx = await signedContract.withdrawCapital(depositID, options);
            console.log('TX Hash:', tx.hash);

            await tx.wait();
            console.log('Withdrew:', total, symbol);

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
        let signedToken = undefined;
        if (tokenContract) {
            signedToken = tokenContract.connect(wallet);
        }

        console.log('Compound wallet:', wallet.address);

        const rawRewards = await contract.getAllClaimableReward(wallet.address);
        //console.log('rawRewards',rawRewards);
        let rewards = Number(parseFloat(ethers.utils.formatEther(rawRewards)));
        let balance = await getBalance(wallet.address);
        //console.log('rewards',rewards);
        if ((rewards - amountToLeave) >= compoundMin) {
            //const preBalance = await getBalance(wallet.address);
            //console.log('prebalance',preBalance);
            const claimed = await claimRewardsByWallet(wallet, signedContract, rewards);
            //console.log('after claiming rewards',claimed);

            if (claimed) {
                balance = await getBalance(wallet.address);
                let depAmount = (Math.floor(balance) * restakeRate) - amountToLeave;
                if (depAmount >= minDeposit) {
                    await deposit(wallet, signedContract, depAmount, signedToken);
                }

                if (restakeRate < 1) {
                    await transfer(wallet, xferWallet, Math.floor(balance) * (1 - restakeRate) - amountToLeave);
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
            console.log('\n', key);
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
            if (maxFeePerGas.gt(maxGasFeeForAuto)) {
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
                case 'approve':
                case 'app':
                    await approveByIndex(myArgs[1], myArgs[2]);
                case 'dep':
                case 'deposit':
                    if (myArgs[1]) {
                        await depositByKey(walletConfig[myArgs[1]].private)
                    } else {
                        await doAllDeposits();
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
        approve,
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
        withdrawCapitalByIndex,
        withdrawCapitalByWallet,
        withdrawCapitalByDeposit,
        compoundWallet,
        compoundWallets,
        autoCompound,
        consolidate,
        run
    }
}


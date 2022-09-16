
# StableFund Stake Utility

## Background
I like to write code and experiment with DeFi, Web3, and other crypto themes.  I also like to automate things that I normally need to manually take care of.

If you're unfamiliar with Stablefund.app, see https://stablefund.app/ for more info.  I created a messy version of this script from a different project, but kept adding to it and even finding myself sharing it to help others.


## Installation

 1. Install [NodeJS](https://nodejs.org/en/download/)
 2. Clone the repo and cd into it
 3. `npm install`
 4. Create conf/config.json
	  - For plain text config, simply copy `config-template.json` to `config.json` and fill it out.
	  - **OPTIONAL**: For secure config using [@tsnx/secure-config](https://www.npmjs.com/package/@tsmx/secure-config)
		  - Copy the template to `config-raw.json` and fill it out
		  - Export the CONFIG_ENCRYPTION_KEY
		  - Then, use this command:
`secure-config-tool create -p "address,private,xfer_wallet,getblock_key,coinapi_key,cmc_api_key,owlracle_key" conf/config-raw.json > conf/config.json`
		 - Finally, discard or move `config-raw.json`.
 5. Use one of the built-in scripts for a site:
 	- node `sfMatic.js <command>` for Matic
	- node `sfBUSD.js <command>` for BUSD
	- node `sfBNB.js <command>` for BNB
	- Or create your own: <br/>
		`import StakeUtil from "./src/StakeUtil.js";`<br/>
		`const stake = StakeUtil({ .... });`

## config.json Structure

The config file is a JSON object.  It's actually not necessary and you can skip down to <a href="#Usage">Usage</a> if you want to simply hard code these values into the StakeUtil module when you instantiate it.

        {
		    "stablefund.app": {  // site name
			    "wallets": {
				    "SF1": {
					    "name": "SF 1",
					    "address": "your public address for wallet 1",
					    "private": "your private key for wallet 1"
					 },
					 "SF2": { 
						... 
					}
				},
		        "xfer_wallet": "public address",
			    "leave": 2.5,
			    "compounds_per_day": 1,
			    "compound_min": 20,
			    "restake_rate": 0
        	},
			"stablefund.appBUSD": { 
				... 
			},
			"coinapi_key": "for coin API pricing",
			"getblock_key": "for alternative provider",
			"cmc_api_key": "for coinmarketcap pricing",
		}

### Per site:
 - **wallets**: One or more wallets used to interact with the smart contract
 - Each wallet object is called by its label, i.e. "SF1" which are used when giving commands to the script, such as "dep SF2", which would deposit all the funds from the SF2 wallet
 - **xfer_wallet**: Public address where to transfer withdrawals of capital or rewards that aren't restaked into the same wallet.  When using the *consolidating* mode this should be set to the last wallet in the *wallets* list.
 - **leave**: How much of the token to leave in the wallet when transferring or depositing.
 - **compounds_per_day**: How many times to compound per day when in auto-compound or auto-consolidate mode.
 - **compound_min**: The minimum amount of rewards to claim and compound.
 - **restake_rate**: Between 1 and 0, how much to retake when in auto-compound mode.  Set to 0 when condolidating or harvesting all rewards.  A value of 1 will compound all rewards when in auto-compound mode.

### General:

 - **cmc_api_key**: Your CoinMarketCap API key, used for pricing
 - **getblock_key**: Your Get Block API key, used for alternative providers
 - **owlracle_key**: Your Owlracle API key for estimating BNB gas fees

## Usage

Each instance of StakeUtil is instantiated with a few parameters, some required.  In the files for each fund, i.e. `sfMatic.js`, this is already implemented based on using the config described above.

    const stake = StakeUtil({ ... parameters ... });

### Required parameters:

- **walletConfig**: Object containing one or more wallet configurations for interacting with the smart contract
- **symbol**: Token or coin symbol
- **contractAddress**: Public address of the smart contract
- **abi**: ABI object for smart contract
- **JsonProvider** OR **WSSProvider**: Full URL of either the JSON RPC provider or the WebSockets provider
	- JSON: https://polygon-rpc.com/  
	- JSON: https://matic.getblock.io/mainnet/?api_key=...
	- WebSockets: wss://matic.getblock.io/mainnet/?api_key=...
	- JSON: https://bsc-dataseed.binance.org/
	- JSON: https://bsc.getblock.io/mainnet/?api_key=...
	- WebSockets: wss://bsc.getblock.io/mainnet/?api_key=...

### Optional parameters:
- **xferWallet**: Where to send rewards or withdrawals to
- **amountToLeave**: Amount to leave in the wallet when depositing or transferring
- **tokenAddress**: Public address for the token used with funds that use a token rather than the native coin for a blockchain, i.e. BUSD
- **approveEveryTxn**: true/false (default), whether to require a specific approval for each token transfer for BUSD.  If set to false, then you must use the **approve** command (see below) before any deposits
- **scanURL**: URL of the block explorer for this blockchain transactions
- **gasStation**: URL for grabbing estimated gas fees at the current time
	- https://gasstation-mainnet.matic.network/v2
	- https://owlracle.info/bsc/gas?apikey=...
- **gasPriority**: Used with Polygon, which set of fees to use (safeLow, standard, fast)
- **maxFeePerGas**: Manually set, used with Polygon (in gwei), see https://polygonscan.com/gastracker
- **maxPriorityFeePerGas**: Manually set, used with Polygon (in gwei)
- **maxGasFeeForAuto**: When auto-compounding or consolidating, do not transact if maxFeePerGas higher than this amount in gwei (Polygon)
- **gasLimit**: Manually set gas limit for write actions on the smart contract or transfers (in wei)
- **momentFormat**: Used to format time stamps
- **compoundsPerDay**: How many time to compound per day when in auto-compound or auto-consolidate mode
- **minDeposit**: Minimum amount in a deposit to claim
- **checkBalanceRetrySeconds**: How many seconds to wait before checking the balance while waiting for transactions to clear
- **checkBalanceRetryAttempts**: How many times to check the balance waiting for transactions to clear
- **CMCAPIKey**: API key for CoinMarketCap, used to get the current price

### Commands
To run the script, using commands:

    const  args = process.argv.slice(2);
    stake.run(args).
This assumes that you're calling your script like this:
   

     node sfMatic.js <command> [arg1] [arg2]

The list of available commands:

 - **bal**: List the quick balance of the contact, wallets, and pending rewards.
	 - arg (optional): the label of one wallet to check
 - **full**: List the full balance of the above, including capital, capital eligible for withdrawl, daily rate, and next compound value
	 - arg (optional): the label of one wallet to check
 - **deplist**: List the full balance as above, but also list every active deposit
	 - arg (optional): the label of one wallet to check
 - **dep**: Perform deposits of all configured wallets
	 - arg (optional): the label of one wallet to use only
 - **claim**: Claim all rewards from all configured wallets
	 - arg (optional): the label of one wallet to use
 - **withdraw**: Withdraw all eligible deposits from all configured wallets
	 - arg (optional): the label of one wallet
	 - arg2 (optional, unless wallet specified): the deposit ID to be withdrawn, get from *deplist*.
 - **transfer**: Transfer all funds from one wallet to another
	 - arg: The label of the wallet to transfer from
	 - arg2: The label of the wallet to transfer to
 - **comp**: Compound all rewards back into the wallet they came from
 - **autocomp**: Automatically compound, running as a daemon, per the configured compounds per day
 - **con**: Consolidate rewards from the other wallets to the last configured wallet, useful when getting the balance up on a new wallet, set xferWallet to the address of the last wallet and restakeRate to 0 when using this mode.
 - **autocon**: Automatically consolidate as with autocompound.
 - **approve**: For BUSD, preapprove token transfers.
	 - arg: amount to approve or "max" for the maximum amount (effectively unlimited)

## New Address Utility
To create a new wallet you could use wallet software that exports a private key, or you can use the newAddress.js script included here.


     node src/newAddress.js

It outputs something like this:

     Address: 0xA2CC....AAdF0
	 Mnemonic: twelve word phrase you can store safely but not needed piano shrug
	 Private Key: 0xbc3...4fef1

Use the private key to configure the script.  Do not share.  If this never gets used on your computer, such as in a wallet browser extension, but instead stays on a dedicated device or cloud compute instance, then even if you slip up and click on a malicious link the hackers cannot get your private key **because it won't exist on your computer**.

## FAQ

- Why does this script need my private key?
	- In order to interact with the smart contract, transactions need to be signed with your private key.
	- You can secure your private key using the [@tsnx/secure-config](https://www.npmjs.com/package/@tsmx/secure-config) tool.
- Where should I run it to be the most secure?
	- You could run this script on a secured cloud compute instance (i.e. at AWS or Azure).  
	- I personally run the script on a [Raspberry Pi](https://www.raspberrypi.org/) not attached to my other computers. This means my private keys are not on my laptop or desktop computers.
- Could I use my hardware wallet (i.e. Ledger)?
	- No.
	- Those require you to manually approve each transaction and only storing your private keys on the device.  So, the kind of commands this script uses and autocompounding do not fit into the paradign of using a hardware wallet.
- What's a good autocompounding strategy?
	- Ask around.
	- Common strategies are once per day, twice per day, or three times per day (once every 8 hours).
	- Compounding requires at least 2 transactions: claim rewards and create a new deposit.  Each transaction uses gas fees, though these tend to be small.
	- Compounding too often could cost more in fees than you receive in extra rewards, it also creates many tiny deposits which slow down the script and increase transactions fees in the future as processing your rewards means looping through many more deposits.
	- Compounding too infrequently reduces the effective APR.

## Considerations

If you like this script and you're feeling generous, here's my tip jar address: `0xb9d73Fb5Ed03494CB11c4809704a7fc1f8ebB6A8` (ETH, MATIC, BSC/BNB).

**Note**: This is unaudited code and is not necessarily production ready.  Test before using.



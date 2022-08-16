
# StableFund Stake Utility

## Background
I like to write code and experiment with DeFi, Web3, and other crypto themes.  

If you're unfamiliar with Stablefund.app, see https://stablefund.app/ for more info.  I created a messy version of this script from a different project, but kept adding to it and even finding myself sharing it to help others.


## Installation

 1. Clone the repo and cd into it
 2. `npm install`
 3. Create conf/config.json
	  - For plain text config, simply copy `config-template.json` to `config.json` and fill it out.
	  - For secure config using [@tsnx/secure-config](https://www.npmjs.com/package/@tsmx/secure-config)
		  - Copy the template to `config-raw.json` and fill it out
		  - Export the CONFIG_ENCRYPTION_KEY
		  - Then, use this command:
`secure-config-tool create -p "address,private,xfer_wallet,getblock_key,coinapi_key,cmc_api_key" conf/config-raw.json > conf/config.json`
		 - Finally, discard or move `config-raw.json`. 
 4. Use one of the built-in scripts for a site or customize your own <br/>
		`import StakeUtil from "./src/StakeUtil.js";`<br/>
		`const stake = StakeUtil({ .... });`

## config.json Structure

The config file is a JSON object.  It's actually not necessary and you can skip down to Usage if you want to simply hard code these values into the StakeUtil module when you instantiate it.

        {
		    "stablefund.app": {  // site name
			    "wallets": {
				    "SF1": {
					    "name": "SF 1",
					    "address": "your public address for wallet 1",
					    "private": "your private key for wallet 1"
					 },
					 "SF2": { ... }
				},
		        "xfer_wallet": "public address",
			    "leave": 2.5,
			    "compounds_per_day": 1,
			    "compound_min": 20,
			    "restake_rate": 0
        },
        "stablefund.appBUSD": { ... },
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

## Usage

Each instance of StakeUtil is instantiated with a few parameters, some required.  In the files for each fund, i.e. `sfMatic.js`, this is already implemented based on using the config described above.

    const stake = StakeUtil({ ... parameters ... });

### Required parameters:

- **walletConfig**: Object containing one or more wallet configurations for interacting with the smart contract
- **symbol**: Token or coin symbol
- **contractAddress**: Public address of the smart contract
- **abi**: ABI object for smart contract
- **JsonProvider** OR **WSSProvider**: Full URL of either the JSON RPC provider or the WebSockets provider

### Optional parameters:
- **xferWallet**: Where to send rewards or withdrawals to
- **amountToLeave**: Amount to leave in the wallet when depositing or transferring
- **tokenAddress**: Public address for the token used with funds that use a token rather than the native coin for a blockchain, i.e. BUSD
- **scanURL**: URL of the block explorer for this blockchain transactions
- **gasStation**: URL for grabbing estimated gas fees at the current time
	- https://gasstation-mainnet.matic.network/v2
	- https://owlracle.info/bsc/gas?apikey=...
- **gasPriority**: Used with Polygon, which set of fees to use (safeLow, standard, fast)
- **maxFeePerGas**: Manually set, used with Polygon
- **maxPriorityFeePerGas**: Manually set, used with Polygon
- **gasLimit**: Manually set gas limit for write actions on the smart contract or transfers
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
   

     node sfMatic.js arg1 arg2

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
	 - arg2 (optional, unless wallet specific): the deposit ID to be withdrawn, get from *deplist*.
 - **transfer**: Transfer all funds from one wallet to another
	 - arg: The label of the wallet to transfer from
	 - arg2: The label of the wallet to transfer to
 - **comp**: Compound all rewards back into the wallet they came from
 - **autocomp**: Automatically compound, running as a daemon, per the configured compounds per day
 - **con**: Consolidate rewards from wallets to the last configured wallet, useful when getting the balance up on a new wallet
 - **autocon**: Automatically consolidate as with autocompound.

## Considerations

If you like this script and you're feeling generous, here's my tip jar address: `0x5e3aE649f3354584A0feA76f83C0315494d12B7e` (ETH, MATIC, BSC/BNB).

**Note**: This is unaudited code and is not necessarily production ready.  Test before using.



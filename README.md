# Aadhaar Voting
 You can view this project deployed at https://voteblocks.netlify.app/. VoteBlocks  is a decentralised web 3.0 based online voting system which allow voters to vote securely and anonymously while maintaining privacy and transparency.

## :desktop_computer: Project Framework

* __Frontend__ : React JS
* __BlockChain__ : Polygon Mumbai Testnet
* __Contract/Backend__ : Solidity
* __IPFS__ : Infura
* __Contract Management__ : Truffle

## :electron: Project Features

* Role Based Authorization
* Separate Dashboards for Voter/Admin
* TOTP 2FA with Google Authenticator
* Unique Password 🔑 Generation for addresses
* Unique Setup Key Generator for addresses for connection to Google Authenticator
* QR Code for scanning key directly into Google Authenticator 
* Decentralised file storage using Infura
* Communication with blockchain via Metamask

## :ballot_box_with_check: Admin Login Test Data <br>
* Import account 0x2AAD4FFDefCAB7D7Dd0B8D500a8f70c1A38513e4 into Metamask with private key
```bash
e439ae6593376e149f0421f7ae7b3c777cc1da5e7d47923766f2e0f85030e723
```
* Browse to https://voteblocks.netlify.app/adminApp/adminLogin or localhost:port/adminApp/adminLogin <br> Note : THIS PAGE IS ACCESSIBLE ONLY IF WALLET ADDRESS IS GIVEN ADMIN RIGHTS
* Aadhar ID : 111111111111
* Login Key
```text
d&0at5mh]25cD#Jf{edc8-0adf73W07@eK4df0fd4bF=HW17580d8d.<N05Haob3ix=Ka1v&%a
```
* Google Authenticator Setup Key
```bash
GNLTAN3FJM2GIZRQ
```


## Description

* The authority must login first with the provided session ID.
* The voter can now begin the process of voting with proper authentication through OTP(one time password) on the respective linked mobile number.
* If the voter is valid then the system will check for for the voters age and the address to which he can give vote.
* the voting pallete will be opned with  candidate names,their parties and logos.
* Now the voter can give his vote by clicking vote button.
* one voter can give his vote only once,i.e after one time voting buttons are disabled and the vote is automatically loged out.
* Same process continiues for many more votters irrespective of their voting wards.

### Installing and Running Project

Clone Project
```
git clone git@https://github.com/shashvat-singham/Blockchain-Aadhar-voting.git
```
Install Dependencies
```
npm install
```
Running Project
```
node index.js
```
If dependency problem occurs delete package.json, Run
```
npm init
```
Again Install dependencies and run project.


### Running Project
Step 1 - Setting up Environment
Instead of developing the app against the live Ethereum blockchain, we have used an in-memory blockchain (think of it as a blockchain simulator) called testrpc.

```
npm install ethereumjs-testrpc web3
```

Step 2 - Creating Voting Smart Contract

```
npm install solc
```

Replace your aadhaar no and phone number for running project at https://github.com/sanattaori/techdot/blob/7814403250f8b042992c6d437d9f9db8f98f3729/ui/js/app.js#L39

Step 3 - Testing in node console

Not required just for testing in node console-
After writing our smart contract, we'll use Web3js to deploy our app and interact with it
```
$ node
> Web3 = require('web3')
> web3 = new Web3(new Web3.providers.HttpProvider("http://localhost:8545"));
Then ensure Web3js is initalized and can query all accounts on the blockchain

> web3.eth.accounts
Lastly, compile the contract by loading the code from Voting.sol in to a string variable and compiling it

> code = fs.readFileSync('Voting.sol').toString()
> solc = require('solc')
> compiledCode = solc.compile(code)
```
testrpc creates 10 test accounts to play with automatically. These accounts come preloaded with 100 (fake) ethers.

Deploy the contract!

dCode.contracts[‘:Voting’].bytecode: bytecode which will be deployed to the blockchain.
compiledCode.contracts[‘:Voting’].interface: interface of the contract (called abi) which tells the contract user what methods are available in the contract.
```
> abiDefinition = JSON.parse(compiledCode.contracts[':Voting'].interface)
> VotingContract = web3.eth.contract(abiDefinition)
> byteCode = compiledCode.contracts[':Voting'].bytecode
>deployedContract = VotingContract.new(['Sanat','Aniket','Mandar','Akshay'],{data: byteCode, from: web3.eth.accounts[0], gas: 4700000})
> deployedContract.address
> contractInstance = VotingContract.at(deployedContract.address)
deployedContract.address. When you have to interact with your contract, you need this deployed address and abi definition we talked about earlier.
```
Step 4 - Interacting with the Contract via the Nodejs Console
```
> contractInstance.totalVotesFor.call('Sanat').toLocaleString()
'2'
```

### For TypeError: Cannot read property ':Voting' of undefined :
Make sure you have ganache-cli
```
sudo npm install ganache-cli -g
```
copy address of first account
```
$ ganache-cli
```



### Purpose of test

 * The authority login is to ensure security to prevent piracy,harresment and corruption from candidates standing in election.
 * OTP generation is to authenticate the right aadhar card owner.
 * button disabling and automatic logout is to prevent multiple voting by single candidate. 


## Deployment

The Aadhaar based voting system is developed to overcome the flaws of EVM system. So directly EVM will be replaced by touch screen interface having the great
user interface and high security.



## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details

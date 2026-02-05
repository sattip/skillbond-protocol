# SkillBond Protocol — Deployment Guide

## Prerequisites
- Node.js 18+
- Base Sepolia testnet ETH in deployer wallet

## Wallet
- Address: `0xeCE5F83e1eD3d5CB9Ae7F9415463Eb50af4D1E0e`
- Private key: in `.env` file
- Need ~0.01 ETH on Base Sepolia

## Get Base Sepolia ETH (free)
1. Alchemy: https://www.alchemy.com/faucets/base-sepolia (sign in with Google)
2. Superchain: https://app.optimism.io/faucet (connect MetaMask)
3. QuickNode: https://faucet.quicknode.com/base/sepolia

## Deploy

```bash
# Install deps
npm install

# Compile
npx hardhat compile

# Run tests
npx hardhat test

# Deploy to Base Sepolia
npx hardhat run scripts/deploy.js --network baseSepolia
```

Save the deployed contract address, then:

```bash
# Verify on BaseScan
npx hardhat verify --network baseSepolia <CONTRACT_ADDRESS> 0x036CbD53842c5426634e7929541eC2318f3dCF7e
```

## Run Demo (after deploy)

```bash
REGISTRY_ADDRESS=<CONTRACT_ADDRESS> npx hardhat run scripts/demo.js --network baseSepolia
```

## Key Addresses
- USDC (Base Sepolia): `0x036CbD53842c5426634e7929541eC2318f3dCF7e`
- SkillBondRegistry: `<deployed address>`

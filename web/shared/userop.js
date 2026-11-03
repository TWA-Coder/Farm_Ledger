// ERC-4337 v0.7 UserOperation helpers shared by the browser (smart-account signer), the bundler service and tests.
// The RPC format (eth_sendUserOperation) uses the unpacked fields below; the EntryPoint takes the packed struct.
// CommonJS so the Hardhat tests and services can require it.
const { ethers } = require("ethers");

const ENTRYPOINT_ABI = [
  "function getNonce(address sender, uint192 key) view returns (uint256)",
  "function getUserOpHash((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature) userOp) view returns (bytes32)",
  "function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops, address beneficiary)",
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
  "event UserOperationRevertReason(bytes32 indexed userOpHash, address indexed sender, uint256 nonce, bytes revertReason)",
  "error FailedOp(uint256 opIndex, string reason)",
  "error FailedOpWithRevert(uint256 opIndex, string reason, bytes inner)",
];
const FACTORY_ABI = [
  "function createAccount(address owner, uint256 salt) returns (address)",
  "function getAddress(address owner, uint256 salt) view returns (address)",
];
const ACCOUNT_ABI = [
  "function execute(address dest, uint256 value, bytes func)",
  "function executeBatch(address[] dest, uint256[] value, bytes[] func)",
  "function owner() view returns (address)",
];

const accountIface = new ethers.Interface(ACCOUNT_ABI);
const factoryIface = new ethers.Interface(FACTORY_ABI);

const pack128 = (high, low) => ethers.toBeHex((BigInt(high) << 128n) | BigInt(low), 32);

// Unpacked (RPC) -> packed (EntryPoint) form.
function packUserOp(op) {
  const initCode = op.factory ? ethers.concat([op.factory, op.factoryData || "0x"]) : "0x";
  const paymasterAndData = op.paymaster
    ? ethers.concat([op.paymaster, ethers.toBeHex(BigInt(op.paymasterVerificationGasLimit || 0), 16), ethers.toBeHex(BigInt(op.paymasterPostOpGasLimit || 0), 16), op.paymasterData || "0x"])
    : "0x";
  return {
    sender: op.sender,
    nonce: BigInt(op.nonce),
    initCode,
    callData: op.callData,
    accountGasLimits: pack128(op.verificationGasLimit, op.callGasLimit),
    preVerificationGas: BigInt(op.preVerificationGas),
    gasFees: pack128(op.maxPriorityFeePerGas, op.maxFeePerGas),
    paymasterAndData,
    signature: op.signature || "0x",
  };
}

// JSON-safe copy (bigints as hex strings) for the RPC.
const toRpc = (op) => Object.fromEntries(Object.entries(op).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, typeof v === "bigint" ? ethers.toBeHex(v) : v]));

// calls: [{ to, data }] -> SimpleAccount callData (execute for one call, executeBatch for several)
function encodeCalls(calls) {
  if (calls.length === 1) return accountIface.encodeFunctionData("execute", [calls[0].to, 0, calls[0].data || "0x"]);
  return accountIface.encodeFunctionData("executeBatch", [calls.map((c) => c.to), [], calls.map((c) => c.data || "0x")]);
}

const factoryData = (owner, salt = 0n) => factoryIface.encodeFunctionData("createAccount", [owner, salt]);

module.exports = { ENTRYPOINT_ABI, FACTORY_ABI, ACCOUNT_ABI, packUserOp, toRpc, encodeCalls, factoryData };

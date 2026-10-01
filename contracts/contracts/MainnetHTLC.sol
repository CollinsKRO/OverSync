// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IResolverRegistry} from "./v2/interfaces/IResolverRegistry.sol";

/**
 * @title MainnetHTLC - Mainnet Optimized Cross-Chain Bridge
 * @dev Simplified HTLC implementation optimized for mainnet deployment
 * @notice Secure cross-chain token swaps between Ethereum and Stellar
 */
contract MainnetHTLC is ReentrancyGuard {
    
    // ═══════════════════════════════════════════════════════════════════════════════════════
    // STRUCTS & ENUMS
    // ═══════════════════════════════════════════════════════════════════════════════════════
    
    enum OrderStatus {
        Created,        // Order created and funded
        Claimed,        // Order successfully claimed
        Refunded        // Order refunded due to timeout
    }
    
    struct Order {
        address sender;           // Order creator
        address token;            // Token being locked
        uint256 amount;           // Amount locked
        bytes32 hashLock;         // Hash of the secret
        uint256 timelock;         // Expiration timestamp
        address beneficiary;      // Receives the claimed amount
        address refundAddress;    // Who gets refund
        OrderStatus status;       // Current status
        uint256 createdAt;        // Creation timestamp
    }
    
    // ═══════════════════════════════════════════════════════════════════════════════════════
    // STATE VARIABLES
    // ═══════════════════════════════════════════════════════════════════════════════════════
    
    mapping(bytes32 => Order) public orders;
    mapping(address => bytes32[]) public userOrders;
    
    uint256 public nextOrderId = 1;
    uint256 public constant minTimelock = 5 minutes;
    uint256 public constant maxTimelock = 1 days;
    // Like v2, the optional registry gates creation only; settlement is permissionless.
    IResolverRegistry public immutable resolverRegistry;
    
    // ═══════════════════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════════════════════
    
    event OrderCreated(
        bytes32 indexed orderId,
        address indexed sender,
        address indexed beneficiary,
        address token,
        uint256 amount,
        bytes32 hashLock,
        uint256 timelock
    );
    
    event OrderClaimed(
        bytes32 indexed orderId,
        address indexed claimer,
        bytes32 secret
    );
    
    event OrderRefunded(
        bytes32 indexed orderId,
        address indexed refundReceiver
    );
    
    // ═══════════════════════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════════════════════
    
    constructor(IResolverRegistry _resolverRegistry) {
        resolverRegistry = _resolverRegistry;
    }
    
    // ═══════════════════════════════════════════════════════════════════════════════════════
    // CORE FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════════════════
    
    /**
     * @dev Create a new HTLC order
     * @param token Token contract address (use address(0) for ETH)
     * @param amount Amount to lock
     * @param hashLock Hash of the secret
     * @param timelock Expiration timestamp
     * @param beneficiary Address that receives the claimed amount
     * @param refundAddress Address that receives refund after timeout
     */
    function createOrder(
        address token,
        uint256 amount,
        bytes32 hashLock,
        uint256 timelock,
        address beneficiary,
        address refundAddress
    ) external payable nonReentrant returns (bytes32 orderId) {
        require(amount > 0, "Amount must be > 0");
        require(hashLock != bytes32(0), "Invalid hash lock");
        require(timelock >= block.timestamp + minTimelock, "Timelock too early");
        require(timelock <= block.timestamp + maxTimelock, "Timelock too late");
        require(beneficiary != address(0), "Invalid beneficiary");
        require(refundAddress != address(0), "Invalid refund address");
        if (address(resolverRegistry) != address(0)) {
            require(resolverRegistry.isActive(msg.sender), "Resolver not authorised");
        }
        
        // Generate order ID
        orderId = keccak256(abi.encodePacked(msg.sender, nextOrderId, block.timestamp));
        nextOrderId++;
        
        // Handle token transfer
        if (token == address(0)) {
            // ETH deposit
            require(msg.value == amount, "ETH amount mismatch");
        } else {
            // ERC20 deposit
            require(msg.value == 0, "No ETH for ERC20 orders");
            IERC20(token).transferFrom(msg.sender, address(this), amount);
        }
        
        // Create order
        orders[orderId] = Order({
            sender: msg.sender,
            token: token,
            amount: amount,
            hashLock: hashLock,
            timelock: timelock,
            beneficiary: beneficiary,
            refundAddress: refundAddress,
            status: OrderStatus.Created,
            createdAt: block.timestamp
        });
        
        // Track user orders
        userOrders[msg.sender].push(orderId);
        
        emit OrderCreated(orderId, msg.sender, beneficiary, token, amount, hashLock, timelock);
    }
    
    /**
     * @dev Claim an order by providing the secret
     * @param orderId Order ID to claim
     * @param secret Secret that matches the hash lock
     */
    function claimOrder(bytes32 orderId, bytes32 secret) external nonReentrant {
        _claimOrder(orderId, abi.encodePacked(secret), secret);
    }

    /// @notice Claim with a variable-length preimage, as supported by v2.
    function claimOrder(bytes32 orderId, bytes calldata preimage) external nonReentrant {
        bytes32 eventSecret;
        if (preimage.length > 0) {
            assembly {
                eventSecret := calldataload(preimage.offset)
            }
        }
        _claimOrder(orderId, preimage, eventSecret);
    }

    function _claimOrder(bytes32 orderId, bytes memory preimage, bytes32 eventSecret) private {
        Order storage order = orders[orderId];
        
        require(order.sender != address(0), "Order not found");
        require(order.status == OrderStatus.Created, "Order not claimable");
        require(block.timestamp <= order.timelock, "Order expired");
        require(sha256(preimage) == order.hashLock ||
                keccak256(preimage) == order.hashLock, "Invalid secret");
        
        // Update order status
        order.status = OrderStatus.Claimed;
        
        // Transfer tokens to beneficiary
        if (order.token == address(0)) {
            // Transfer ETH
            payable(order.beneficiary).transfer(order.amount);
        } else {
            // Transfer ERC20
            IERC20(order.token).transfer(order.beneficiary, order.amount);
        }
        
        emit OrderClaimed(orderId, msg.sender, eventSecret);
    }
    
    /**
     * @dev Refund an expired order
     * @param orderId Order ID to refund
     */
    function refundOrder(bytes32 orderId) external nonReentrant {
        Order storage order = orders[orderId];
        
        require(order.sender != address(0), "Order not found");
        require(order.status == OrderStatus.Created, "Order not refundable");
        require(block.timestamp > order.timelock, "Order not expired");
        
        // Update order status
        order.status = OrderStatus.Refunded;
        
        // Transfer tokens back to refund address
        if (order.token == address(0)) {
            // Transfer ETH
            payable(order.refundAddress).transfer(order.amount);
        } else {
            // Transfer ERC20
            IERC20(order.token).transfer(order.refundAddress, order.amount);
        }
        
        emit OrderRefunded(orderId, order.refundAddress);
    }
    
    // ═══════════════════════════════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════════════════
    
    /**
     * @dev Get order details
     */
    function getOrder(bytes32 orderId) external view returns (Order memory) {
        return orders[orderId];
    }
    
    /**
     * @dev Get user orders
     */
    function getUserOrders(address user) external view returns (bytes32[] memory) {
        return userOrders[user];
    }
    
    /**
     * @dev Check if order exists and is active
     */
    function isOrderActive(bytes32 orderId) external view returns (bool) {
        Order memory order = orders[orderId];
        return order.sender != address(0) && 
               order.status == OrderStatus.Created && 
               block.timestamp <= order.timelock;
    }
    
    /**
     * @dev Get contract balance
     */
    function getBalance(address token) external view returns (uint256) {
        if (token == address(0)) {
            return address(this).balance;
        } else {
            return IERC20(token).balanceOf(address(this));
        }
    }
    
    // ═══════════════════════════════════════════════════════════════════════════════════════
    // RECEIVE FUNCTION
    // ═══════════════════════════════════════════════════════════════════════════════════════
    
    receive() external payable {
        // Allow contract to receive ETH
    }
}

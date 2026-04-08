import { HelpCircle, Lock, Shield, Layers, Eye, Scale, Zap, Bot, DollarSign, FileCheck } from "lucide-react";

export type FaqEntry = { icon: React.ReactNode; category: string; q: string; a: string };

export const faqs: FaqEntry[] = [
  {
    icon: <HelpCircle className="w-5 h-5" />,
    category: "Basics",
    q: "What is a zero-knowledge proof?",
    a: "Imagine proving you're over 18 without showing your ID. A zero-knowledge proof works the same way — it proves a fact is true without revealing any details. In zkScatter, it proves your trade is legitimate without anyone seeing who you are, what you traded, or how much.",
  },
  {
    icon: <Lock className="w-5 h-5" />,
    category: "Privacy",
    q: "How does zkScatter protect my privacy?",
    a: "When you deposit, your funds are converted into an encrypted commitment — like putting cash in an opaque lockbox. On-chain, every lockbox looks identical. When you later claim funds to a new wallet, a ZK proof proves you own the right lockbox without opening it. No one can connect your deposit to your withdrawal.",
  },
  {
    icon: <Shield className="w-5 h-5" />,
    category: "Privacy",
    q: "What's the difference between statistical and cryptographic privacy?",
    a: "Mixing services like Tornado Cash use statistical privacy — you hide in a crowd. If 100 people deposited, an attacker has a 1-in-100 chance of guessing which withdrawal is yours. But if only 3 people deposited, you're barely hidden. zkScatter uses cryptographic privacy instead. The ZK proof mathematically guarantees that no observer can learn which deposit was consumed — even if you are the only person in the pool. Privacy comes from the math, not from the crowd.",
  },
  {
    icon: <Eye className="w-5 h-5" />,
    category: "Privacy",
    q: "What exactly is hidden on-chain?",
    a: "Everything that matters. When a trade settles, a ZK proof verifies the trade is valid but hides: the token types involved, the amounts, the depositor's address, the recipient's address, and the timing of claims. On-chain observers see only identical-looking hash commitments going in and ZK proofs coming out — like watching sealed envelopes enter and leave a building with no way to match them.",
  },
  {
    icon: <Layers className="w-5 h-5" />,
    category: "Architecture",
    q: "How does the three-layer separation work?",
    a: "zkScatter splits its architecture into three distinct layers. Layer 1 (Application): you sign orders in the browser using EdDSA keys — orders are plaintext so relayers can efficiently match them. Layer 2 (Matching): relayers cooperate off-chain to find the best counterparty, like a real estate MLS sharing listings. Layer 3 (Settlement): this is where privacy lives. A Groth16 ZK proof settles the trade on-chain, cryptographically breaking the link between your deposit and the recipient's claim. The key insight is that trade transparency does not imply fund flow transparency — hiding the match is expensive, but hiding the settlement is efficient.",
  },
  {
    icon: <Layers className="w-5 h-5" />,
    category: "Architecture",
    q: "If orders are visible to relayers, isn't that a privacy risk?",
    a: 'No — this is a deliberate design choice. Think of relayers like a real estate MLS (Multiple Listing Service): agents share listings openly to find the best match faster. In zkScatter, orders are transparent to relayers so they can cooperate and maximize liquidity without expensive cryptographic overhead. Privacy doesn\'t come from hiding orders — it comes from hiding the settlement. Even though a relayer sees "someone sold 10 ETH at $2100," nobody can trace which deposit funded it or where the proceeds ended up.',
  },
  {
    icon: <Scale className="w-5 h-5" />,
    category: "Compliance",
    q: "If it's private, how is it legal?",
    a: 'zkScatter uses a Dual-CA model. Your identity is verified once via zk-X509 (similar to how your browser verifies websites), but only a "verified" flag is stored on-chain — your real identity stays off-chain. Meanwhile, relayers who match trades are publicly licensed entities. If law enforcement needs to investigate, they go through the relayer — the protocol\'s encryption is never broken.',
  },
  {
    icon: <Scale className="w-5 h-5" />,
    category: "Compliance",
    q: "What is a 'legal backdoor without a cryptographic backdoor'?",
    a: "It means the protocol has zero master keys or built-in decryption — no one, not even the developers, can break the math protecting your privacy. But compliance still works: relayers operate as licensed public entities with legal obligations. If authorities detect illicit funds, they serve a court order to the specific relayer, who hands over their off-chain order logs. This is exactly how traditional finance works — your bank can be subpoenaed, but the protocol itself (e.g. SWIFT) is not weakened. This avoids the Tornado Cash problem, where the absence of any accountable intermediary led to OFAC sanctioning the entire protocol.",
  },
  {
    icon: <Scale className="w-5 h-5" />,
    category: "Compliance",
    q: "How can law enforcement investigate if everything is private?",
    a: "Through relayers, not through the protocol's encryption. Relayers are publicly registered legal entities — their identity, jurisdiction, and license are visible on-chain. If illicit funds are detected, law enforcement identifies which relayer processed the trade, obtains a court order for that specific entity, and the relayer discloses their off-chain order logs. This is a legal backdoor, not a cryptographic one — the protocol's math is never compromised, and uninvolved users are never affected.",
  },
  {
    icon: <Zap className="w-5 h-5" />,
    category: "Usage",
    q: 'What does "gasless claim" mean?',
    a: "Normally you need ETH to interact with the blockchain. But if you withdraw to a brand-new wallet, funding it with ETH could reveal who you are. With gasless claims, the relayer pays the transaction fee on your behalf. Your new wallet receives funds directly with zero prior history.",
  },
  {
    icon: <Bot className="w-5 h-5" />,
    category: "Security",
    q: "Can bots steal my trade profits?",
    a: "No. On typical DEXs, bots see your pending order and trade ahead of you (front-running) or squeeze your trade with a sandwich attack. In zkScatter, orders are signed off-chain at a fixed price and settled atomically via ZK proofs. By the time anything reaches the blockchain, the trade is already done and all parameters are hidden.",
  },
  {
    icon: <DollarSign className="w-5 h-5" />,
    category: "Cost",
    q: "How much does it cost?",
    a: "A full private trade (deposit, settlement, and claim) costs about ~3,500K gas. On Ethereum L1 that's a few dollars; on L2 networks like Optimism or Base it's under $0.01. The ZK proof verification is constant-cost regardless of trade complexity.",
  },
  {
    icon: <FileCheck className="w-5 h-5" />,
    category: "Trust",
    q: "Is zkScatter audited?",
    a: "zkScatter is currently in active development. All smart contracts and ZK circuits will undergo professional security audits before mainnet deployment. The code is open-source and available for review on GitHub.",
  },
];

export const categoryColors: Record<string, string> = {
  Basics: "text-on-surface-variant",
  Privacy: "text-primary",
  Architecture: "text-secondary",
  Compliance: "text-tertiary",
  Usage: "text-primary",
  Security: "text-error",
  Cost: "text-secondary",
  Trust: "text-tertiary",
};

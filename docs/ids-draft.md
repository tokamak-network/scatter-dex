# Information Disclosure Statement (IDS) — Draft

> **Status**: Draft for review
> **Purpose**: Satisfy the applicant's duty of disclosure under 37 CFR §1.56 / §1.97 / §1.98 for the US patent application covering the zkScatter invention disclosed in `docs/PAPER.md`. When the jurisdiction is not the US (e.g., Korean provisional → PCT), an equivalent prior-art disclosure statement is prepared from the same reference list.
> **Scope**: This draft is limited to prior art that was **known to the applicant** at the time of filing and that is **material** to patentability under the Rule 56 standard. It is not a substitute for a professional prior-art search performed by outside counsel.
> **Related docs (in repo)**:
> - [PAPER.md](PAPER.md) §10 "Closest Prior Art: Jigsaw [23]" — the narrative disclosure of the Jigsaw reference in the specification
> - [PAPER-ko.md](PAPER-ko.md) §10 "가장 가까운 선행기술: Jigsaw [23]" — Korean mirror
> - [architecture-v2.md](architecture-v2.md) — Design decisions that distinguish over the references below
>
> **Internal-only, non-repo notes** (referenced for provenance; reviewers do **not** need access to these to review this draft):
> - `project_audit_findings_2026-04-09.md` — historical context for how the Jigsaw omission was identified during the 2026-04-09 audit. Maintained as a private working note in the applicant team's internal memory store, not committed to this repository.
> - `project_patent_disclosure.md` — internal patent drafting notes covering the filing-state and provenance of the disclosure. Also a private working note, not committed to this repository.

---

## 1. Why this document exists

During the 2026-04-09 audit, a reviewer flagged that **Jigsaw (Cryptology ePrint Archive 2025/1147)** — identified in the prior-art search as the closest published construction to the present disclosure — was **entirely absent** from the specification's Background section. Leaving this reference out of the filing would expose the applicant to two distinct problems:

1. **Inequitable conduct / Rule 56 risk (US).** Under 37 CFR §1.56, each individual associated with the filing has a duty to disclose to the USPTO all information known to be material to patentability. Suppressing the single closest known prior-art reference — especially one identified by the applicant's own search — would, if later discovered, be cited as a paradigm inequitable-conduct fact pattern. The consequences under *Therasense v. Becton Dickinson* (Fed. Cir. 2011) are severe enough that the safer path is always disclosure + distinction, not omission.

2. **Examiner optics.** Even in jurisdictions without a formal Rule 56 obligation (KIPO, EPO), an examiner who independently discovers a reference the applicant should plausibly have known about will allocate the benefit of the doubt away from the applicant. The specification currently includes Tornado Cash, Railgun, Renegade, and Penumbra — an examiner reading the ePrint 2025/1147 abstract will wonder why the most recent and most directly related reference was excluded from that same list.

The mitigation is to (a) cite Jigsaw in the specification itself — **done** in `PAPER.md` §10 and `PAPER-ko.md` §10 — and (b) file a contemporaneous IDS (or jurisdiction-equivalent) that lists Jigsaw alongside the other references the applicant relied on in the prior-art search. This document drafts that IDS.

---

## 2. Reference list

Each entry below is formatted to fit directly into USPTO form **PTO/SB/08a** (Non-Patent Literature) when the application is filed in the US. For PCT filings, the same list is transcribed into the Form PCT/IB/376 equivalent. For Korean provisional filings, the reference list is embedded in the specification's Background section (already done in `PAPER-ko.md` §2 and §10).

### 2.1 Closest prior art

**[NPL-1] Garg, S., Goel, A., Kolonelos, D., Sinha, R. *Jigsaw: Doubly Private Smart Contracts*.**
Cryptology ePrint Archive, Paper 2025/1147, 2025.
First published: 2025-06-18. Last revised: 2025-10-15.
URL: https://eprint.iacr.org/2025/1147
PDF: https://eprint.iacr.org/2025/1147.pdf
IACR keywords: Privacy-Preserving Smart Contracts; zkSNARKs; Collaborative zkSNARKs.
ePrint category: APPLICATIONS.

Relevance: **Closest known prior art.** Proposes a framework for *doubly private* smart contracts addressing both on-chain and off-chain privacy, in which clients submit privacy-preserving requests to a group of mutually-untrusting servers that collaboratively match those requests. The realization builds on the ZEXE architecture (Bowe et al., S&P 2020) and extends Collaborative zkSNARKs (Ozdemir and Boneh, USENIX 2022) to enable proof generation by a group of servers. Demonstrated on sample applications including a decentralized exchange, auctions, and voting.

Distinguished from the present disclosure by: (i) collaborative multi-server proof generation versus single-prover client-side proving on the user's own device, which is the dominant architectural difference and the reason zkScatter does not require Collaborative zkSNARKs at all; (ii) absence of a dual-CA compliance layer; (iii) absence of a Layer 3 trade-claim dissociation step that decouples settlement-time recipient visibility from the claim redemption event; (iv) absence of a federated relayer accountability model with public on-chain identity. See `PAPER.md` §10 "Closest Prior Art: Jigsaw [23]" for the full distinction.

> **Verification status (2026-04-10)**: The verbatim title, full author list (4 authors), publication date (2025-06-18), and last-revision date (2025-10-15) above were confirmed against the live ePrint record at https://eprint.iacr.org/2025/1147 on 2026-04-10. Re-verify immediately before IDS submission, since the ePrint record can be revised after this date.

### 2.2 Privacy-preserving DEX and DeFi primitives cited in the specification

**[NPL-2]** Renegade. *A Dark Pool DEX Using MPC*. https://renegade.fi, 2023.
Relevance: Cited in specification §2, §10. MPC-based dark pool DEX; distinguished by the present disclosure's use of non-interactive ZK proofs and ZK commitment pools in place of MPC.

**[NPL-3]** Railgun. *Privacy System for DeFi*. https://railgun.org, 2022.
Relevance: Cited in specification §2, §10. ZK-based privacy for DeFi balances; distinguished by the present disclosure's dual-CA compliance layer and Layer 3 claim dissociation.

**[NPL-4]** Penumbra. *A Private DEX on Cosmos*. https://penumbra.zone, 2023.
Relevance: Cited in specification §14. Shielded DEX on Cosmos; distinguished by L1/L2 EVM targeting and the compliance model.

**[NPL-5]** Pertsev, A., Semenov, R., Storm, R. *Tornado Cash Privacy Solution*. 2019.
Relevance: Cited in specification §2, §6, §8. ZK mixer providing statistical/anonymity-set privacy without a compliance layer; distinguished as the specific failure mode the present disclosure is designed to avoid (OFAC sanctions due to absent accountable intermediary — see specification §8 "Why This Avoids the Tornado Cash Problem").

**[NPL-6]** Bunz, B. et al. *Zether: Towards Privacy in a Smart Contract World*. FC, 2020.
Relevance: Cited in specification §14. Account-based privacy on Ethereum; referenced for completeness of the privacy-primitive landscape.

**[NPL-7]** Seres, I. et al. *Mixeth: Efficient, Trustless Coin Mixing Service for Ethereum*. 2021.
Relevance: Cited in specification §14. Trustless mixer; referenced for completeness of the privacy-primitive landscape.

### 2.3 Off-chain-order / intent-based DEX prior art

**[NPL-8]** Warren, W., Bandeali, A. *0x: An Open Protocol for Decentralized Exchange on the Ethereum Blockchain*. 2017.
Relevance: Cited in specification §14. Off-chain orderbook with on-chain settlement; distinguished by absence of privacy and compliance layers.

**[NPL-9]** CoW Protocol. *Batch Auctions with Coincidence of Wants*. https://cow.fi, 2022.
Relevance: Cited in specification §14. Batch-auction DEX with solver-based matching; distinguished as above.

**[NPL-10]** 1inch Network. *Fusion Mode: Intent-Based Swaps with Resolvers*. 2023.
Relevance: Cited in specification §14. Intent-based DEX with resolver network; distinguished as above.

### 2.4 Cryptographic primitives underpinning the construction

**[NPL-11]** Grassi, L. et al. *Poseidon: A New Hash Function for Zero-Knowledge Proof Systems*. USENIX Security, 2021.
Relevance: Cited in specification §4, §14. Hash function used inside the settle/deposit/withdraw/claim/authorize circuits. Not itself a prior-art construction against the invention; listed for completeness because it is an essential building block.

**[NPL-12]** Goldreich, O. *Foundations of Cryptography: Volume 2*. Cambridge University Press, 2004.
Relevance: Foundational cryptography reference cited in specification §14.

**[NPL-13]** Canetti, R. *Universally Composable Security*. FOCS, 2001.
Relevance: Security-model reference cited in specification §14.

**[NPL-14]** Shoup, V. *Sequences of Games*. Cryptology ePrint Archive, 2004.
Relevance: Proof-technique reference cited in specification §14.

### 2.5 MEV / front-running prior art

**[NPL-15]** Daian, P. et al. *Flash Boys 2.0: Frontrunning in Decentralized Exchanges*. IEEE S&P, 2020.
Relevance: Cited in specification §7, §14. Foundational MEV analysis; referenced for completeness of the MEV-resistance motivation.

**[NPL-16]** Eskandari, S. et al. *SoK: Transparent Dishonesty — Front-Running Attacks on Blockchain*. FC Workshop, 2020.
Relevance: Cited in specification §14. MEV-attack taxonomy.

**[NPL-17]** Flashbots. *MEV-Share: Programmable Order Flow*. 2023.
Relevance: Cited in specification §14. Comparative MEV-mitigation architecture; distinguished by the present disclosure's settlement-layer MEV immunity (§7).

**[NPL-18]** Babel, K. et al. *Clockwork Finance: Automated Analysis of Economic Security*. IEEE S&P, 2023.
Relevance: Cited in specification §14. Economic-security analysis framework.

### 2.6 Compliance / identity prior art

**[NPL-19]** Zcash Foundation. *Selective Disclosure and Viewing Keys in Shielded Protocols*. 2022.
Relevance: Cited in specification §14. Viewing-key-based compliance; distinguished by the present disclosure's external dual-CA model (no viewing keys; identity is held outside the ZK layer).

**[NPL-20]** Sonnino, A. et al. *Coconut: Threshold Issuance Selective Disclosure Credentials*. NDSS, 2019.
Relevance: Cited in specification §14. Credential primitive; distinguished by the present disclosure's use of two operationally independent CAs with opposing disclosure policies rather than a threshold-credential scheme.

**[NPL-21]** Buterin, V., Illum, J., Nadler, M., Schar, F., Soleimani, A. *Blockchain Privacy and Regulatory Compliance: Towards a Practical Equilibrium*. 2023.
Relevance: Cited in specification §8, §14. The "practical equilibrium" framing paper that motivates the present disclosure's dual-CA approach; distinguished by the fact that this reference is a policy paper, not a prior-art construction.

---

## 3. Identification of the closest prior art — examiner-facing note

For an examiner reviewing the present application, the following single reference is identified as the primary piece of prior art against which patentability is asserted:

**Closest prior art: [NPL-1] Garg, Goel, Kolonelos, Sinha. *Jigsaw: Doubly Private Smart Contracts*. Cryptology ePrint Archive, Paper 2025/1147, 2025.**

The applicant acknowledges Jigsaw as the most directly related construction known to the applicant at the time of filing. The distinction over Jigsaw is summarised in `PAPER.md` §10 and falls into the following load-bearing differences:

| # | Element | Jigsaw | Present disclosure |
|---|---|---|---|
| 1 | Proof-generation architecture | **Collaborative multi-server proving** — clients submit privacy-preserving requests to a group of mutually-untrusting servers that jointly run a Collaborative zkSNARK (Ozdemir & Boneh, USENIX 2022). Privacy depends on no majority of those servers colluding. | **Single-prover client-side proving** on the user's own device (browser / mobile). Each user proves their own side via the Half-proof primitive in `circuits/authorize.circom`. The relayer never holds witness data. Trust assumption reduces to "the user's own device is uncompromised". |
| 2 | Compliance / accountability layer | None — Jigsaw, like Tornado Cash, Railgun, Renegade, and Penumbra, has no integrated compliance or regulator-facing audit surface. | Dual-CA identity with opposing disclosure policies — enables regulator cooperability without degrading per-user privacy. Addresses the Tornado Cash regulatory failure mode directly. |
| 3 | Recipient visibility at settlement | Single-step collaborative match → on-chain settle. Recipient becomes visible at settlement. | Layer 3 claim dissociation — recipient is revealed only at the claim step, against a claims-root committed at settlement time, without revealing which claim is being redeemed. Turns computational privacy into traffic-independent cryptographic privacy at the recipient layer. |
| 4 | Relayer / matcher accountability | Servers are accountable for liveness and correctness only. No on-chain identity, no regulator interface. | Federated relayer network with public Dual-CA identity in `RelayerRegistry`, record-only `DisputeRegistry`, and reputation enforcement. Accountability is the load-bearing co-design with the privacy architecture. |
| 5 | Settlement fan-out (implementation, not a claim element) | Single shielded output per party in the sample DEX application. | N-way claim fan-out per side (N = 16 in the reference circuit; parameter, not claim-narrowing element). |

Elements 1, 2, 3, and 4 are each load-bearing claim elements. Element 5 is described as an implementation-level feature only and is not itself the basis for patentability over Jigsaw.

---

## 4. Ongoing-disclosure obligation

Under 37 CFR §1.97(b)-(c), the IDS obligation continues throughout prosecution. The applicant (and each person associated with the application) must cite any **newly discovered** material prior art to the USPTO within the filing windows prescribed by that rule. In practice this means:

1. Any new reference identified by opposing counsel in a pre-issuance submission must be forwarded to outside counsel within 3 business days of receipt.
2. Any new reference identified by the applicant's own ongoing monitoring of Cryptology ePrint, IACR conferences (CRYPTO, Eurocrypt, S&P, FC, NDSS, USENIX), ArXiv `cs.CR`, and SSRN must likewise be forwarded within 3 business days.
3. A follow-up IDS is prepared and filed whenever (1) or (2) triggers; the format mirrors §2 of this draft.

The monitoring responsibility is assigned to the applicant team (not outside counsel) because the applicant is the party in the best position to recognise technical relevance. Outside counsel handles only the formal IDS submission once the relevance determination is made.

---

## 5. Pre-filing checklist

Before submitting this IDS alongside the filing package, confirm:

- [x] **2026-04-10** — The ePrint 2025/1147 bibliographic record has been re-read verbatim and the title (`Jigsaw: Doubly Private Smart Contracts`), author list (Sanjam Garg, Aarushi Goel, Dimitris Kolonelos, Rohit Sinha), publication date (2025-06-18), and last-revision date (2025-10-15) in [NPL-1], `PAPER.md` §14, and `PAPER-ko.md` §14 match the current ePrint listing exactly.
- [ ] **Re-verify immediately before filing** — confirm the ePrint record has not been revised between 2026-04-10 and the filing date. If a newer revision exists, update [NPL-1], `PAPER.md` §14, and `PAPER-ko.md` §14 to the new revision date and re-read the abstract for any material changes.
- [ ] `PAPER.md` §10 "Closest Prior Art: Jigsaw [23]" and the Korean mirror in `PAPER-ko.md` §10 are included in the final filed specification (not dropped during formatting conversion).
- [ ] The reference list in §2 of this IDS draft matches the reference list in `PAPER.md` §14 (same numbering, no additions missed).
- [ ] Outside counsel has been given the opportunity to add any reference that surfaces during their independent prior-art search before the final IDS is locked for submission.

---

## 6. Change log

- **2026-04-10** — Initial draft in response to audit finding 2026-04-09 that Jigsaw was absent from the Background section. Drafted by the applicant team; outside counsel review pending.
- **2026-04-10 (later same day)** — Verbatim verification pass against the live ePrint 2025/1147 record. Title corrected from the speculative "Jigsaw: A Privacy-Preserving Trade Primitive" to the actual "Jigsaw: Doubly Private Smart Contracts". Full author list (Garg, Goel, Kolonelos, Sinha) added. The §3 examiner-facing distinction table was rewritten because the actual Jigsaw architecture (collaborative multi-server proving via ZEXE + Collaborative zkSNARKs, not single-prover shielded balances) differs substantially from the initial speculation; the new table reflects the real Jigsaw design and produces a stronger distinction over the present disclosure.

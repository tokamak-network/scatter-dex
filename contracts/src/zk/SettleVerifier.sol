// SPDX-License-Identifier: GPL-3.0
/*
    Copyright 2021 0KIMS association.

    This file is generated with [snarkJS](https://github.com/iden3/snarkjs).

    snarkJS is a free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    snarkJS is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
    License for more details.

    You should have received a copy of the GNU General Public License
    along with snarkJS. If not, see <https://www.gnu.org/licenses/>.
*/

pragma solidity >=0.7.0 <0.9.0;

contract Groth16Verifier {
    // Scalar field size
    uint256 constant r    = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size
    uint256 constant q   = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // Verification Key data
    uint256 constant alphax  = 21453198727776139087419428906065808286606573647564108419292103698640906223874;
    uint256 constant alphay  = 9404247001616600853624244252485898872814751337440908970900751097733868970098;
    uint256 constant betax1  = 2208984256590118630672582863085767610004799064917767429529783766243203025344;
    uint256 constant betax2  = 20323700906424095472436200797492622482455341492593966954135533974627232300713;
    uint256 constant betay1  = 20760881093510484537819091280510574545303343217265593116177516601254560196315;
    uint256 constant betay2  = 11980669709104506570842928532354039763608217517855903714675589871315059359442;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 10820964111249697682589198265468252740099198865020910916425471434199582530088;
    uint256 constant deltax2 = 3348344376356142467212629818025469521902536226982169486970226658337365969814;
    uint256 constant deltay1 = 4959565503130055411677736523299933946374180299125912895761101449667907475768;
    uint256 constant deltay2 = 5700036080902468023555331427850629759539629583524288588537969594558688687976;

    
    uint256 constant IC0x = 10246169653903721098606490010013968154075196433526400411147156867807743681032;
    uint256 constant IC0y = 11481657581479955902200297550287224619864413959476444946946043867685118263817;
    
    uint256 constant IC1x = 12481237963155935706001780839692225998950010777661474328836309165764961760035;
    uint256 constant IC1y = 7932243524388971166445262794967654765785151236080515056231330437602547713015;
    
    uint256 constant IC2x = 15303731576671824416834582838701541328703502931670581137285671877675294061019;
    uint256 constant IC2y = 6212729406082042057000436449256438624496661281365823977017266918371828369913;
    
    uint256 constant IC3x = 15908896502566321943388174176255421100823892115251428268598962411983706762558;
    uint256 constant IC3y = 1269810528349428535584052838772240901785742364443858865854047846177894639485;
    
    uint256 constant IC4x = 8094139165103659726583059454895688260006723943580104174293772350904996831561;
    uint256 constant IC4y = 21477180178506679980804789754567391396562850006212129547566046987123397582325;
    
    uint256 constant IC5x = 3114080179180135965982932379744158238487269032164830545665741496555818311276;
    uint256 constant IC5y = 19438880488612805200851065260814313298005587314422742362280081440145691471258;
    
    uint256 constant IC6x = 20432299610936616971568661627750845882200978284509109966686769476521803811969;
    uint256 constant IC6y = 4293436392751032086193182888061148973596608857145736108424842337380733215685;
    
    uint256 constant IC7x = 10063420813014117750098625792481205175626596770404037393884208075800198704207;
    uint256 constant IC7y = 17981717036952202966309397765028213231764789028123509252930540065267025687306;
    
    uint256 constant IC8x = 16174216908344113187924441273754811473652728753696700845901064492289876315927;
    uint256 constant IC8y = 252802724463247349685833423210633049375202141243776288432002969051228154779;
    
    uint256 constant IC9x = 11141820887720934144045686888329862252464722594396124692777693805280330247553;
    uint256 constant IC9y = 6690414174514025343764528613125665537807269148757460390962063752579238337357;
    
    uint256 constant IC10x = 15937213984152789582516887728786826492771091189890243837472722067110610669249;
    uint256 constant IC10y = 13570333979413679558593328698313495963286288665038860922623278445299383427052;
    
    uint256 constant IC11x = 3309209750414001614397244470091311048036600129294775626543292538384392477228;
    uint256 constant IC11y = 16757578729940418029674855595698286526460026065552851983588970849278877480594;
    
    uint256 constant IC12x = 6485343473663278148032995466765879332003905122469223940662069347445379424455;
    uint256 constant IC12y = 6031966886013847954014426366373325606449948162052782697857320907817402311958;
    
    uint256 constant IC13x = 18362408469023691755635581757329444051638035853976536886733608119726306928140;
    uint256 constant IC13y = 18069719144397305159184573031391132446276441276196706496966645295651878443812;
    
    uint256 constant IC14x = 18904294406153826111980885541139938861490462343012809315821509215979522787830;
    uint256 constant IC14y = 1843238257677592193957393758311382519051590252680616188970898023744061407551;
    
    uint256 constant IC15x = 9217887038788244935625723158252129177373045031809872707080346959021360857673;
    uint256 constant IC15y = 17751059024939478823265832710881772641191474811006384193436315422052486840025;
    
 
    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[15] calldata _pubSignals) public view returns (bool) {
        assembly {
            function checkField(v) {
                if iszero(lt(v, r)) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }
            
            // G1 function to multiply a G1 value(x,y) to value in an address
            function g1_mulAccC(pR, x, y, s) {
                let success
                let mIn := mload(0x40)
                mstore(mIn, x)
                mstore(add(mIn, 32), y)
                mstore(add(mIn, 64), s)

                success := staticcall(sub(gas(), 2000), 7, mIn, 96, mIn, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }

                mstore(add(mIn, 64), mload(pR))
                mstore(add(mIn, 96), mload(add(pR, 32)))

                success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            function checkPairing(pA, pB, pC, pubSignals, pMem) -> isOk {
                let _pPairing := add(pMem, pPairing)
                let _pVk := add(pMem, pVk)

                mstore(_pVk, IC0x)
                mstore(add(_pVk, 32), IC0y)

                // Compute the linear combination vk_x
                
                g1_mulAccC(_pVk, IC1x, IC1y, calldataload(add(pubSignals, 0)))
                
                g1_mulAccC(_pVk, IC2x, IC2y, calldataload(add(pubSignals, 32)))
                
                g1_mulAccC(_pVk, IC3x, IC3y, calldataload(add(pubSignals, 64)))
                
                g1_mulAccC(_pVk, IC4x, IC4y, calldataload(add(pubSignals, 96)))
                
                g1_mulAccC(_pVk, IC5x, IC5y, calldataload(add(pubSignals, 128)))
                
                g1_mulAccC(_pVk, IC6x, IC6y, calldataload(add(pubSignals, 160)))
                
                g1_mulAccC(_pVk, IC7x, IC7y, calldataload(add(pubSignals, 192)))
                
                g1_mulAccC(_pVk, IC8x, IC8y, calldataload(add(pubSignals, 224)))
                
                g1_mulAccC(_pVk, IC9x, IC9y, calldataload(add(pubSignals, 256)))
                
                g1_mulAccC(_pVk, IC10x, IC10y, calldataload(add(pubSignals, 288)))
                
                g1_mulAccC(_pVk, IC11x, IC11y, calldataload(add(pubSignals, 320)))
                
                g1_mulAccC(_pVk, IC12x, IC12y, calldataload(add(pubSignals, 352)))
                
                g1_mulAccC(_pVk, IC13x, IC13y, calldataload(add(pubSignals, 384)))
                
                g1_mulAccC(_pVk, IC14x, IC14y, calldataload(add(pubSignals, 416)))
                
                g1_mulAccC(_pVk, IC15x, IC15y, calldataload(add(pubSignals, 448)))
                

                // -A
                mstore(_pPairing, calldataload(pA))
                mstore(add(_pPairing, 32), mod(sub(q, calldataload(add(pA, 32))), q))

                // B
                mstore(add(_pPairing, 64), calldataload(pB))
                mstore(add(_pPairing, 96), calldataload(add(pB, 32)))
                mstore(add(_pPairing, 128), calldataload(add(pB, 64)))
                mstore(add(_pPairing, 160), calldataload(add(pB, 96)))

                // alpha1
                mstore(add(_pPairing, 192), alphax)
                mstore(add(_pPairing, 224), alphay)

                // beta2
                mstore(add(_pPairing, 256), betax1)
                mstore(add(_pPairing, 288), betax2)
                mstore(add(_pPairing, 320), betay1)
                mstore(add(_pPairing, 352), betay2)

                // vk_x
                mstore(add(_pPairing, 384), mload(add(pMem, pVk)))
                mstore(add(_pPairing, 416), mload(add(pMem, add(pVk, 32))))


                // gamma2
                mstore(add(_pPairing, 448), gammax1)
                mstore(add(_pPairing, 480), gammax2)
                mstore(add(_pPairing, 512), gammay1)
                mstore(add(_pPairing, 544), gammay2)

                // C
                mstore(add(_pPairing, 576), calldataload(pC))
                mstore(add(_pPairing, 608), calldataload(add(pC, 32)))

                // delta2
                mstore(add(_pPairing, 640), deltax1)
                mstore(add(_pPairing, 672), deltax2)
                mstore(add(_pPairing, 704), deltay1)
                mstore(add(_pPairing, 736), deltay2)


                let success := staticcall(sub(gas(), 2000), 8, _pPairing, 768, _pPairing, 0x20)

                isOk := and(success, mload(_pPairing))
            }

            let pMem := mload(0x40)
            mstore(0x40, add(pMem, pLastMem))

            // Validate that all evaluations ∈ F
            
            checkField(calldataload(add(_pubSignals, 0)))
            
            checkField(calldataload(add(_pubSignals, 32)))
            
            checkField(calldataload(add(_pubSignals, 64)))
            
            checkField(calldataload(add(_pubSignals, 96)))
            
            checkField(calldataload(add(_pubSignals, 128)))
            
            checkField(calldataload(add(_pubSignals, 160)))
            
            checkField(calldataload(add(_pubSignals, 192)))
            
            checkField(calldataload(add(_pubSignals, 224)))
            
            checkField(calldataload(add(_pubSignals, 256)))
            
            checkField(calldataload(add(_pubSignals, 288)))
            
            checkField(calldataload(add(_pubSignals, 320)))
            
            checkField(calldataload(add(_pubSignals, 352)))
            
            checkField(calldataload(add(_pubSignals, 384)))
            
            checkField(calldataload(add(_pubSignals, 416)))
            
            checkField(calldataload(add(_pubSignals, 448)))
            

            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }

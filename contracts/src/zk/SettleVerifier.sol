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
    uint256 constant deltax1 = 14850676830428627223977514742796967334960023859419822574634891672108739942034;
    uint256 constant deltax2 = 2467112357448140214885488927404263742141239461237188152197520279513708200067;
    uint256 constant deltay1 = 16465739272456871117446026762493423752482462571168397961078401605740744186912;
    uint256 constant deltay2 = 6373051250455868393280123519217563907327778209351509674834991650382613763182;

    
    uint256 constant IC0x = 11856754360497954478728255972237025448317910058216723965116056294584090380902;
    uint256 constant IC0y = 17783719333626627441854587535232800600538882463090045169193868383789346360005;
    
    uint256 constant IC1x = 9749062803349956472463796002355941964935881684098711892658937193579690578449;
    uint256 constant IC1y = 20133822315365642538014626338838293841211611669477891184259028740520763294369;
    
    uint256 constant IC2x = 3739877621265598787800677947915647135204278736051722707918863613807521487722;
    uint256 constant IC2y = 16664524268557845163872323558327257970655719008890389852884437066454951239017;
    
    uint256 constant IC3x = 3926437574558651510048395431400774107967820786924874139619918966685016216606;
    uint256 constant IC3y = 6933801240496069522265487102175320859897225856178733545326741462999943868439;
    
    uint256 constant IC4x = 6997116170407663572725394487659162781198048584335356510809463346047361011837;
    uint256 constant IC4y = 14435746231678733833423407483867571200228823595413986842500350599941192043187;
    
    uint256 constant IC5x = 11245542825664708148561131060008332215219621564985929175099331288738993081623;
    uint256 constant IC5y = 2807538760581294466437965815310673479614656076881769227784826792947218439512;
    
    uint256 constant IC6x = 4464524858605330203760020967068114669599436727162330519632535173565466336062;
    uint256 constant IC6y = 6321006173493884010216158149811305624298348884885160820474712582172369065329;
    
    uint256 constant IC7x = 2351609739802312934008741818058164999776388039397666816856847881012915426942;
    uint256 constant IC7y = 9864993673327094151948065294286254947353776631946412763657600897541031978332;
    
    uint256 constant IC8x = 3062672783550702128436130792498056544388880707640470011789660039105418070883;
    uint256 constant IC8y = 17651287225863568516628997441413962002459059750462737066760936902828550309795;
    
    uint256 constant IC9x = 17848215280668193632677263157434057321678146382672896308007798095974964548745;
    uint256 constant IC9y = 1055638541620369281623649541653352470041277392061168299436339635870919543611;
    
    uint256 constant IC10x = 213107919591223758654314406795678917352238222107642008184432995679755074443;
    uint256 constant IC10y = 15750389497430260625168254816127677832908819399355652024826958684300068677099;
    
    uint256 constant IC11x = 5449495114210442877661053450778692449410968612684778089776509438653253280884;
    uint256 constant IC11y = 17072271564253481176365589407996762737946239570497190505772847897013922092395;
    
    uint256 constant IC12x = 16991923104819582215331124245319897009350056900075855647439986295351057419031;
    uint256 constant IC12y = 9219638784608701760743162782295463206202452229658407453622598258452043332496;
    
    uint256 constant IC13x = 1017586814520198003445558912496557502558912750895430995583758764823008185343;
    uint256 constant IC13y = 1072152849342837345261999923341798256960620831606790937626937557923363423862;
    
    uint256 constant IC14x = 19643459443843054146337616304151877581600357158908369160062468538948260847446;
    uint256 constant IC14y = 3356471834460563565917356286958724221548096629518723647816140303227602362934;
    
    uint256 constant IC15x = 17735166717505303305119285199030806639991894284112788518813870870410046623024;
    uint256 constant IC15y = 11274033703073317420852584237503214301677096451175294651095510204735856489243;
    
    uint256 constant IC16x = 19291523257059503896058983969887062023869632807877391051233876344651038403997;
    uint256 constant IC16y = 20356284548024434320572400480055853947415202312429074131665038060099887305206;
    
 
    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[16] calldata _pubSignals) public view returns (bool) {
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
                
                g1_mulAccC(_pVk, IC16x, IC16y, calldataload(add(pubSignals, 480)))
                

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
            
            checkField(calldataload(add(_pubSignals, 480)))
            

            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }

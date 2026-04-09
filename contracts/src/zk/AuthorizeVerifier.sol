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
    uint256 constant deltax1 = 11921054663695137285756844821490018112180814469460403605637501702420847924827;
    uint256 constant deltax2 = 198463111421557735722924862013222734432808103151126056828712711406249266380;
    uint256 constant deltay1 = 18436520203212282006510270151510832176822698757206827531224777527919490632509;
    uint256 constant deltay2 = 1413824867656669770329099001565111161557521946932048979529017368511765239214;

    
    uint256 constant IC0x = 6985435085752279801818987389061526079252347376962011421740188717164907020983;
    uint256 constant IC0y = 14148947442341656602947708742533141297096462614755409082996006289560884164139;
    
    uint256 constant IC1x = 10403304953990961682759786913203143291517239817558795733133729120829778901318;
    uint256 constant IC1y = 13281165215175578601807018670021420800706193768094953541701959418055642641456;
    
    uint256 constant IC2x = 15765399936948136813018360890039067373904885954755848291325136655499492633197;
    uint256 constant IC2y = 5987253965483753327063991039780861597858839487452379216197816833221332857344;
    
    uint256 constant IC3x = 11348925951763763745717746619883809147567483310837243956125170162661477235896;
    uint256 constant IC3y = 1574595255957684746211410601487281064204229007377336749716268680904608141163;
    
    uint256 constant IC4x = 8363663674321891976301007427728544159820671558471920474975749444477211343080;
    uint256 constant IC4y = 5296557206603567061631486628544830857275498129498562401141004614688968546548;
    
    uint256 constant IC5x = 5397144907683185611061398582170977159683351549378872958084267457522489895607;
    uint256 constant IC5y = 11751068338510170093614818926908755458453167239180965467947230129465322047839;
    
    uint256 constant IC6x = 4944330179711580636121115300425487042078894280283849009984912851494107773358;
    uint256 constant IC6y = 994451234820016672152383146061883728277699610078882102126156687380084036629;
    
    uint256 constant IC7x = 6068518052154425680683543118829991339556476000095671696791330178247580270930;
    uint256 constant IC7y = 819665685429941245357968468906844778225763933685477066520455371314161073563;
    
    uint256 constant IC8x = 4909428163600128252861362132356951614758561220189943432285060919402081289845;
    uint256 constant IC8y = 10541861798313236193287505749758718208671720147612019879593489231197778229531;
    
    uint256 constant IC9x = 5468334084338113608265325312228980199090043070028865809242790393700042462280;
    uint256 constant IC9y = 7478626624411131396212880943796073030740724230338729399596405130118129088312;
    
    uint256 constant IC10x = 5619949331887945985449266966804433232783416984438132189493571494537987226733;
    uint256 constant IC10y = 6198556029513562288309243594406483228485360334713077807519034428237925645537;
    
    uint256 constant IC11x = 1513449055703297690850327701921463384496258954492884185337417244649848816874;
    uint256 constant IC11y = 16911617365840264309258930341925809713440551893339640422442939381875763961795;
    
    uint256 constant IC12x = 15591406828192858858486576933806393821048334616515770946707438340054322042838;
    uint256 constant IC12y = 382979120302204014258554296689586118099890345956758231886434428823053086252;
    
    uint256 constant IC13x = 11296919884533585875112366752605346228040758369013333502864933623131601480896;
    uint256 constant IC13y = 18401607637441194905877441499320748278717871493477205051096696065783651516270;
    
    uint256 constant IC14x = 2690190778777370676333256130111996228747101377580667406670389125446945473503;
    uint256 constant IC14y = 11504163300674568071492791894795143992750577388587744382821237671475815785304;
    
    uint256 constant IC15x = 4168740729347681838221188493619310588145986796221858068898865728461570267352;
    uint256 constant IC15y = 17749400107825759676816609502496866438532331012066970884214929583485394763006;
    
 
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

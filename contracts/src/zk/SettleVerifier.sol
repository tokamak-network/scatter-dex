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
    uint256 constant deltax1 = 14924795827480321719410192629556754964382602554577020980232000662069784785588;
    uint256 constant deltax2 = 8368849722742033249109829878894357483231403266006250936294429915660785784529;
    uint256 constant deltay1 = 1105995974464412063542212880654327604929523057401360061356460279847131075518;
    uint256 constant deltay2 = 15554089972705384793923622518525727287149482695056808551487551969615662749753;

    
    uint256 constant IC0x = 19982953974744248179083354709345441990644691638569697277912312882203478035699;
    uint256 constant IC0y = 20251976394346205500434141904235631353163491986961026126348432094148825842976;
    
    uint256 constant IC1x = 12646485804587395320345484227330054524573744970995283652221254659117875490848;
    uint256 constant IC1y = 145380716459565367569558789542135604875966308722923127171876188739754803713;
    
    uint256 constant IC2x = 8453414740800840116297902903216058510971888106388620891433661002626575950882;
    uint256 constant IC2y = 10503676281267526344440830144565855532172528283388885127743383874843347594587;
    
    uint256 constant IC3x = 10714585696924852391718430419614350013063653554069182594776015818639997824018;
    uint256 constant IC3y = 14758787066066030303952131105929591949532807725095437001799567711236173686574;
    
    uint256 constant IC4x = 16263439093602327584453672550861447655872101755342671842937362477544597281631;
    uint256 constant IC4y = 10393419397583790458181955453184624789493919755950956415619654279523277177860;
    
    uint256 constant IC5x = 14872322173324942693160928597668121684055547997715835852743004232287046018967;
    uint256 constant IC5y = 18223010383414127779954407959322798396853312040359696950407548351994348902177;
    
    uint256 constant IC6x = 18592593892996655008544996063478738131408140596453067752155404729231938998113;
    uint256 constant IC6y = 6384327660509839533581041754937832176985844675280540150759484292338930616438;
    
    uint256 constant IC7x = 18352234274265873359815410405482730623235629707639456427010203636357149469110;
    uint256 constant IC7y = 11686294196196756436180098833497425196505975752819529386637301397368292467258;
    
    uint256 constant IC8x = 1439326575681784399301246045686724514255605163631470406378501636554073503525;
    uint256 constant IC8y = 9358984834392848869965366012315563717174227378586199940359845692695228390367;
    
    uint256 constant IC9x = 3288075713033681282156783446494505339336143376346293568629910481695940539583;
    uint256 constant IC9y = 13358236183496325536772165770397935284194792040582296830345340761321288255391;
    
    uint256 constant IC10x = 1669490885074508352447051398026508713633611376068575895093473376033447533721;
    uint256 constant IC10y = 16365117118017572355380534398509298214378492788389567712969089320444127453888;
    
    uint256 constant IC11x = 18940983117759204194403703420915154267719471860611073881824145879947368132021;
    uint256 constant IC11y = 5318940085477321268447675593496009114706875495157752928411393683306632392626;
    
    uint256 constant IC12x = 6071737573501461614784969934954269150305218918580884359496893986403775541608;
    uint256 constant IC12y = 6707609055726659540302770572782373633116395883233713759090373734616092223812;
    
    uint256 constant IC13x = 13288443581763109130197704512161175670153909228723761984395139690963614098891;
    uint256 constant IC13y = 2420883829985914084997565518567483697048673893179905353656903866672917162385;
    
    uint256 constant IC14x = 13628826448781477234244047041771404212153790087059858933803253079655353001386;
    uint256 constant IC14y = 19993430163601694390899213376165816217540245283666900975412878174981822369980;
    
    uint256 constant IC15x = 6596317267339808116014234954248481374189803662229995869004213128643695873061;
    uint256 constant IC15y = 5657216593541149099817439763183918063436225384846987220048955005503873910051;
    
 
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

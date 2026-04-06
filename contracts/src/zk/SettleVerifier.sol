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
    uint256 constant deltax1 = 3049804467406456303447738625994205819636623098848275616917890013267660246701;
    uint256 constant deltax2 = 7168609197521331392970620852449829638647166045197828429844978593643012491591;
    uint256 constant deltay1 = 10279368017014873310260253571336912413033846170450715995337040296200306180818;
    uint256 constant deltay2 = 3928308039984282560517026748290403218121960017160160663651777660025037999816;

    
    uint256 constant IC0x = 8345716502637869620228419512294631822323949460971698683622138678817985341546;
    uint256 constant IC0y = 6200130509441596603705191367912777728472220766555367451779230441915496950359;
    
    uint256 constant IC1x = 7763046866451398617428734304229000409315981290966804176582033054689586503813;
    uint256 constant IC1y = 539981734352410255984787963635326534025925567970430101102356126764311144906;
    
    uint256 constant IC2x = 13357001554631997962167937056145542410466079664833222541939650422672853203000;
    uint256 constant IC2y = 11612288802070838919100062506907039800710044936962114269527929541269307835460;
    
    uint256 constant IC3x = 10721072843016917180863582305172253949877225048701664061873229530559495664495;
    uint256 constant IC3y = 11872032741608475224993261411890100384685310298579696312234297692159201555903;
    
    uint256 constant IC4x = 7251843270455974809259533459259558914503872846337886086626915507170715113280;
    uint256 constant IC4y = 203408047344708513069821173382556439955374365090811402616064718443176174575;
    
    uint256 constant IC5x = 14085156665859909115033813534958848663259094542757112576189464554052503243704;
    uint256 constant IC5y = 8916599072366683270158906531554373266882336326367974206410329958403570678860;
    
    uint256 constant IC6x = 12052331588097179066413645489924627041427089449157286790214148238298169669820;
    uint256 constant IC6y = 20846872855702279445361270287389207935433541570544462967451756242627653781652;
    
    uint256 constant IC7x = 5032918848800446736598867103550509756241767404942596131977251062627922031075;
    uint256 constant IC7y = 5318488769770588960276036878568138062898582605640958252084339036690467502241;
    
    uint256 constant IC8x = 20641436640427148840802811044909529253445906401073621274247179760645757024093;
    uint256 constant IC8y = 8416653256240767583441641841694483518235881049972887672230001642834783629059;
    
    uint256 constant IC9x = 8773142151108766940604632154987581293047463987981464331689876423463853002421;
    uint256 constant IC9y = 4286211390195067678464573336116272131267717771528762776688608592117781786110;
    
    uint256 constant IC10x = 19079229887449286542514369824934339766246717292842993749108004444589282230367;
    uint256 constant IC10y = 21422565549354923757514667832211996680915949314028095426754856117955546294292;
    
    uint256 constant IC11x = 3914670778020262612979080477938284941175812809337242695694045377272651204223;
    uint256 constant IC11y = 18806809335852912816219827979683223013154338934644148046731198309145523293042;
    
    uint256 constant IC12x = 1979124927043016730332257306330025118424880794346386311444624057703728345026;
    uint256 constant IC12y = 18950648546226910024051506271077999507292014247972463868665288469960869686141;
    
    uint256 constant IC13x = 4247712749383114432911512326898425611962155073103893885546763970674324693392;
    uint256 constant IC13y = 7491591472859701870962302240842702359309451211902779896614098083501679217729;
    
    uint256 constant IC14x = 6227848824646770067712993356831824241463358147186252356493123737110550338628;
    uint256 constant IC14y = 290369459889552638892627658818733195920694219586743527098313811117589830264;
    
    uint256 constant IC15x = 21055630140079164719176080534704592276654653602789912637266717459772443254620;
    uint256 constant IC15y = 4019768638201961401724309529795312886664680927546641749744085287583133536750;
    
    uint256 constant IC16x = 15086836570506225255107318694201842526493670386885443588592098609243061285159;
    uint256 constant IC16y = 8593133649954849169962285954754215243210131959044235835417324515737472541555;
    
 
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

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
    uint256 constant alphax  = 11755881944846427342537263146586461506483868137846936785500920548836349349195;
    uint256 constant alphay  = 1240018404257946875576332691375717733594501789704903013869264327527436186061;
    uint256 constant betax1  = 7447508978405288797156093943097096196772028613059671154566512986991351514137;
    uint256 constant betax2  = 756682961301130194392071574286199022657036197188118925230815339011299320007;
    uint256 constant betay1  = 5849578345450612099912065724961974343272794871251995088311750916068400862217;
    uint256 constant betay2  = 19138787293126274001874903365124207947039392543252424502111196142213375638041;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 12801393140489561744450669994815417567267675878646306962572847695663794726915;
    uint256 constant deltax2 = 8058425962339473648962495418781559829125802292187599181133401989287865066035;
    uint256 constant deltay1 = 8311231843320348669021715315944296139835329633602009960192245573343009361224;
    uint256 constant deltay2 = 9643453758647963327917113327780501409576916012609085471158771161112651968089;

    
    uint256 constant IC0x = 17035266095434103273722339747611992666096340869128542338768556275240971570380;
    uint256 constant IC0y = 18476787328537593303609895412230797598587158542343480156239221443935989706865;
    
    uint256 constant IC1x = 6838890547399857960552760680372243658437734455191495871992626391604244897426;
    uint256 constant IC1y = 8353490192438746491770762114338472517399593946648051506565737660057951487788;
    
    uint256 constant IC2x = 13870826586736876507668974087002112435982800026582456448996295580850499033505;
    uint256 constant IC2y = 16299040389758184303616472484390373448376220009707691966437246301335018209354;
    
    uint256 constant IC3x = 3035605034115476646022747421862873426157117403748107892822590248668369798386;
    uint256 constant IC3y = 19622440473015814235680198206920582857455893051476683489189578295065209771527;
    
    uint256 constant IC4x = 10467326143924299414329040775041999300665813710525695384204148004896532824864;
    uint256 constant IC4y = 13209515484988276862994703232169732606931161235159542188819336254058082959907;
    
    uint256 constant IC5x = 20326613316620721522228215424894718330588038024969689894247508508283559890509;
    uint256 constant IC5y = 11813355610697392568068148604990058016546439822212138268719215105563624775458;
    
    uint256 constant IC6x = 20248662821587175499196113796409582180356206837837669826142434075885103987163;
    uint256 constant IC6y = 18747398382647180107350243765850629513211088764402941376007286297200298215520;
    
    uint256 constant IC7x = 16979090194643476777346513293800536320390616467132117648559404998269580155334;
    uint256 constant IC7y = 1169084911310378280534641306987552838154009692967640111742491027700063696771;
    
    uint256 constant IC8x = 21060507939176782198686018824456165818559084176671061242080635950776690608214;
    uint256 constant IC8y = 980709852467811347024305328840625287942028291013145059552683872015441425072;
    
    uint256 constant IC9x = 8326660824907056964692026168000120601570850291853804590080044114012059436049;
    uint256 constant IC9y = 125300463835354670495374295439409237002636967966963895759936411551399888748;
    
    uint256 constant IC10x = 11098885012843845778269758681513373088174484077625710419270898702137658141071;
    uint256 constant IC10y = 14132267000287114503971217067689827869702157741030295801584398679519842739538;
    
    uint256 constant IC11x = 2807992132195763291186980084058653255466472303357044139563018195697531829398;
    uint256 constant IC11y = 7593462867645204843038570692480935191666180414505738039763852473669566119488;
    
    uint256 constant IC12x = 12110607293967850992131990981735503616571537794117106221624369156586618471539;
    uint256 constant IC12y = 5315253795907257269301316243150584239808459526257398435997611523852797873669;
    
    uint256 constant IC13x = 8209001492198503046460773570379975151634714329337019907300122807542474626048;
    uint256 constant IC13y = 15482265200971761247482177512413997478167110544725889210749429884851111839754;
    
    uint256 constant IC14x = 4895272521691485533233748017450896460906284464708698792344540935511215348571;
    uint256 constant IC14y = 21553169540581780460619258516608180197665310881382404420132097367525614628180;
    
    uint256 constant IC15x = 7396512896753697208494371190417051543495099242866392262469547736346244460298;
    uint256 constant IC15y = 16438674289711860427508464747884106142457908011066069600214812702908086227267;
    
 
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

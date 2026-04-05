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
    uint256 constant deltax1 = 10241797275053430890441610912505581947233043245396264478315090578282316212081;
    uint256 constant deltax2 = 7708819347393237282271319677940853794823199765904181194690242014298735181590;
    uint256 constant deltay1 = 14206326828565252002388920511377473955550459967280103183094558153554956407454;
    uint256 constant deltay2 = 3661248264268178669740787182453574318960350209497087090918956268375912579737;

    
    uint256 constant IC0x = 17632611543298289394851834080933110394768099137114597743625223954522530600926;
    uint256 constant IC0y = 437929393571794852230348097503928548317817105148806388962351500766128190462;
    
    uint256 constant IC1x = 8156166896263365796245568253864973708538719107865035826283335780536097283126;
    uint256 constant IC1y = 484815266975319197681401881266234284863366269437304383870150923950791601858;
    
    uint256 constant IC2x = 19223625905730554218822095145357220789767162052881740574069308408776438630798;
    uint256 constant IC2y = 10810194727132256555736659646382254451987763025644259273633044025548471795263;
    
    uint256 constant IC3x = 17760661544407891170827316412937675471260010080155383880317595581747883805612;
    uint256 constant IC3y = 15158170072176898058683311652794923380498245389052467779846514072744480973474;
    
    uint256 constant IC4x = 11483266361759819591172175673136821000275304868483981164838195732048701826120;
    uint256 constant IC4y = 304670125742700427639364091092193725108337259345309565293783617889218676084;
    
    uint256 constant IC5x = 16711804452777331424120383677599345417395610544740024771374593362643367419627;
    uint256 constant IC5y = 4556963242791893862221754318858092014363391387442618724302119415702411292398;
    
    uint256 constant IC6x = 10662594898243583768761444247148014116928119950322715785986689586781755681032;
    uint256 constant IC6y = 16254682732631861470601710205581317564157539686408753274206752838716405216902;
    
    uint256 constant IC7x = 7977206317440784827239226059060140359331263118509615179722031880712882457360;
    uint256 constant IC7y = 18157501378260841865235411542227320147708774368716015730531937113334315760489;
    
    uint256 constant IC8x = 6109576195858473743508666023247865286791387715272579724492021345449360977100;
    uint256 constant IC8y = 6265843771805674724086735647027901271999343805578120450386031832192741390613;
    
    uint256 constant IC9x = 1347602126972470458287248980240050339207778612412921635072677322066113740808;
    uint256 constant IC9y = 1172766946865819061159456562947250950858460401671638000199625631947976574027;
    
    uint256 constant IC10x = 21225960831266872937829453968730927785363474273717624834020872338950352442994;
    uint256 constant IC10y = 1545908594303919346606215301295255135953413289838192612328709769730308517948;
    
    uint256 constant IC11x = 13815324797162674343628603438350104972310808097187917769848819212764068486115;
    uint256 constant IC11y = 1828394647901122542794382712834747866744923133453712009189718857197981102581;
    
    uint256 constant IC12x = 3966337818354224994294727654104058987998389756025952628629221810549561929956;
    uint256 constant IC12y = 12025059383254421724387135363879693462540648280382123114934304360745258344974;
    
    uint256 constant IC13x = 20988202389300642923939628961366489238894796074118609193217343174552487185627;
    uint256 constant IC13y = 20393932642928301116593675566066509380091101635801034267245530677535797251604;
    
    uint256 constant IC14x = 19111623214084646442684716679514608775782018444695380443960311447910553979096;
    uint256 constant IC14y = 15752730812921094649374511776966711542891080197516126042784297696672353598422;
    
    uint256 constant IC15x = 628515131154655100579715410432066601146506796943129358622512052473919542123;
    uint256 constant IC15y = 17909435248983937592846384186070759460901047835788036975526917883509253601801;
    
 
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

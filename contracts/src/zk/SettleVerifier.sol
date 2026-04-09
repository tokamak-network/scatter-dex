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
    uint256 constant deltax1 = 14359728558497761950499254229576903179630599876451786159323524213492722864980;
    uint256 constant deltax2 = 13147595637009744973903715875289794770982996571334296479190287129135490080446;
    uint256 constant deltay1 = 10460760987954639044780823164568307772670140026510028879124558873248971061697;
    uint256 constant deltay2 = 17686263291635228441116263482535413754029176462799528694487164851027336439790;

    
    uint256 constant IC0x = 14448796818665383511589143678677588145473464736959725428547313111639899090975;
    uint256 constant IC0y = 9656693242207475618136293616817038203918073519122775976455472972398261467672;
    
    uint256 constant IC1x = 1439168836848404117111910605523420366645583003926260439535048060419506425537;
    uint256 constant IC1y = 14661417028501695113335491560250329837031841331300161865101071866972061100930;
    
    uint256 constant IC2x = 15574769175026814039345111901230689857155286831258276353558142447987468177960;
    uint256 constant IC2y = 2223475350032730275593736883873371971312847888320568362458339419785496604248;
    
    uint256 constant IC3x = 17304252705074216018975716958004540484711658003917790348032559610666339244122;
    uint256 constant IC3y = 6557787919091966033975456633569574112111880947376776847235967650108249105452;
    
    uint256 constant IC4x = 7753262415901852244842009721202165711510026626756390923626591215714331316274;
    uint256 constant IC4y = 19453200173885071217631148787300035138697420325048561844540547162252418004729;
    
    uint256 constant IC5x = 5738329657209876964095051784856677756465124633192735738555646432561895706266;
    uint256 constant IC5y = 9391971020168012244629893446712132562101951758113191063995193131837848469886;
    
    uint256 constant IC6x = 13214271466270979156057465509505426156885133542979631763269570130245655966902;
    uint256 constant IC6y = 19477100454433451205763804245174472245682188306477700530449962103130923678205;
    
    uint256 constant IC7x = 15300311014132023838737172258637103377310423485588854557079871121268794475377;
    uint256 constant IC7y = 8188830318797384465560179872790259382250997313566078039004047936716883471777;
    
    uint256 constant IC8x = 1713911745704570730218062203679675172548814563423125248403431647317803513908;
    uint256 constant IC8y = 7787187871967745359162913489194215545490292811342478867227148972866447997139;
    
    uint256 constant IC9x = 4152246494518074156162241123623006147755636974031557787205678713400947779963;
    uint256 constant IC9y = 15947452814599644279176427534753944099143282427555871729549740962514266004881;
    
    uint256 constant IC10x = 3693444888443260788414862758280830589754063824311116218268955039488821197256;
    uint256 constant IC10y = 15022616867093033305585541487941618933382228886768784079207130483953109655890;
    
    uint256 constant IC11x = 14664971729034831054787797804813972097411212546175817492552602800661432033064;
    uint256 constant IC11y = 17290645576366944492725616173357363180621414787542818133306263909177938712919;
    
    uint256 constant IC12x = 21043676958264833615429634484555971945980439212633762510466086537104451433101;
    uint256 constant IC12y = 21583897370722621116062191706348640458402787589049494536476670118003045342663;
    
    uint256 constant IC13x = 5379283433137414817899449645901224485106131651130586039352166857523316597949;
    uint256 constant IC13y = 13260841867085669220183729124109848155095312319971909533835194561832798652227;
    
    uint256 constant IC14x = 20860358823538921002857027115167410738658267310707641411163832947588193363471;
    uint256 constant IC14y = 2658596442057118830323225981467910721984518082000971989106615034859516388219;
    
    uint256 constant IC15x = 15184946050793813765636446486781192662606391437983518765948861172319284135723;
    uint256 constant IC15y = 16966904968611533901469185411033316789159240429343365955522311421176864788259;
    
    uint256 constant IC16x = 565969664786616101118916049263123803154421878362349606632338705569856812637;
    uint256 constant IC16y = 14523102882721022901865629302198029433453573288594975013395156430626944159240;
    
    uint256 constant IC17x = 11594129630717371064410966792920638920612870079331994399458723077075718848803;
    uint256 constant IC17y = 5393529083632274107700436265257761077472551102011162626974056104219986660574;
    
    uint256 constant IC18x = 18921380382585219282508396861465033712027438108505532603550521794846635399247;
    uint256 constant IC18y = 14345449592712914492170064922169894563872728564573399373275789571242018038822;
    
 
    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[18] calldata _pubSignals) public view returns (bool) {
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
                
                g1_mulAccC(_pVk, IC17x, IC17y, calldataload(add(pubSignals, 512)))
                
                g1_mulAccC(_pVk, IC18x, IC18y, calldataload(add(pubSignals, 544)))
                

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
            
            checkField(calldataload(add(_pubSignals, 512)))
            
            checkField(calldataload(add(_pubSignals, 544)))
            

            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }

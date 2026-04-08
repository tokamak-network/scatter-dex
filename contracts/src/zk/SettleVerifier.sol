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
    uint256 constant deltax1 = 4700321697550546615904832541152035588373444774291403849942928392933699288238;
    uint256 constant deltax2 = 10728734864648500891592126767175353550520616265757425217659191763298577734448;
    uint256 constant deltay1 = 364181171919549950754153390150918396041563408856265477411888983040550030912;
    uint256 constant deltay2 = 12420631026891753004953443742686954437062469617935069100874483685575500457322;

    
    uint256 constant IC0x = 10700731432832477905864619929823053851396806493908988733464510535523396635928;
    uint256 constant IC0y = 8921869933650357474021596976983252337628914445711322153015773067953117619590;
    
    uint256 constant IC1x = 21735492586635700255135134580218634187339562350469429372236509504214262181202;
    uint256 constant IC1y = 18259900383456490848467202114863391270284075050130139061902611297558909662206;
    
    uint256 constant IC2x = 10463193192834034474320429345354309461474711098827746523513616324415846992794;
    uint256 constant IC2y = 10816155141219912771459450804310461504296459423782199382393237179429248957760;
    
    uint256 constant IC3x = 21544442747342252935684358007465916299211394983109673620607689202941401910971;
    uint256 constant IC3y = 10519681753923216625347411161303177351544970077519124516356745747516692257700;
    
    uint256 constant IC4x = 18354210779011595172573484691800591528735525598314479410772332547755173235161;
    uint256 constant IC4y = 3702793209703964559531068001903356398183676800560752077199800175433125205007;
    
    uint256 constant IC5x = 10936684673324354097595624080378210436342702332236196873067313949970360361602;
    uint256 constant IC5y = 2568484625200038829312193871335571987839227553171259298720273038446418406032;
    
    uint256 constant IC6x = 18922949911765485165090960794294766609041275914553066056963142010863601254487;
    uint256 constant IC6y = 21149742184726792123964440435307145279028420176110312426612159626982400965297;
    
    uint256 constant IC7x = 10691993366887836564033386131986835716627333608422098493393471968673302046740;
    uint256 constant IC7y = 546309654755757068870858421081366597198709381745708168242523016922631405249;
    
    uint256 constant IC8x = 19815799797659726061639440694421919034188556927580158591926619771345647198343;
    uint256 constant IC8y = 542688226281956252623921502801200336123123844328961388594518700361655673763;
    
    uint256 constant IC9x = 20142635433399401957851062027539505094506649028435153484916955048565210443193;
    uint256 constant IC9y = 11984546859797999874403901168546507217935251182534025264256385327842018627086;
    
    uint256 constant IC10x = 6700079900780304498988824611217894119395435063190944013272355217669986694769;
    uint256 constant IC10y = 17482662843821073675446552085592780628301905237298365612884685960301902779002;
    
    uint256 constant IC11x = 4222083062655345020721317883471984545639293589098038581336482632055951787214;
    uint256 constant IC11y = 8567329378143478313596013101720053245477346325116435256106954996905470479031;
    
    uint256 constant IC12x = 18488598840201565519206490785145471024860528008770972804855772558151842059946;
    uint256 constant IC12y = 19861543952668187172169225232594518711744330641607346304825764476220204916685;
    
    uint256 constant IC13x = 2998320217629823596186898468825836316614195064739056009181576143966536537695;
    uint256 constant IC13y = 14773885758199572836790448340879685335138640728980103726089599554700712230788;
    
    uint256 constant IC14x = 17727905558827258363270321118736468526183691414792446728718225274985575705160;
    uint256 constant IC14y = 254287153996298822003898493962618810825719551026307758244809469042446994033;
    
    uint256 constant IC15x = 15595202826187557747695447756438962706611536952872275968619215350811482846188;
    uint256 constant IC15y = 10656983875079958581705650304087814392336642188102742625585774604970151783481;
    
    uint256 constant IC16x = 18999330991007018075115491199088761876436010332493229923609791753932398716737;
    uint256 constant IC16y = 4617217354415300384133259364418422985067535263890869139131151667297394591487;
    
    uint256 constant IC17x = 3324368234139140120372726368356712162744782669785972269321031683328060155935;
    uint256 constant IC17y = 15934370433288143037401201349488421664136614884161977323529506002066789218094;
    
 
    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[17] calldata _pubSignals) public view returns (bool) {
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
            

            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }

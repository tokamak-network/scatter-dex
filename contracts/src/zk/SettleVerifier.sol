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
    uint256 constant deltax1 = 15733232631230730050709177330276857944868204799678362181162353284128450623975;
    uint256 constant deltax2 = 9958026359762120660038667149596639433515385548390794782646354892057237426424;
    uint256 constant deltay1 = 14859626330971376870237793766486122412134763080292832818786684218316361157033;
    uint256 constant deltay2 = 4219400973514111339513587772074563131767717154099266120413854031066490179842;

    
    uint256 constant IC0x = 47878064672173729947880602383504134561515006393975683646763589550807445596;
    uint256 constant IC0y = 1374291508334402453446160720690115952518751644686047534401889642555873678476;
    
    uint256 constant IC1x = 16324592884832291106661225236657188616264997498373045464330261399794340896041;
    uint256 constant IC1y = 10949989409239502147131416059123037624668554886263348940327803775295910794061;
    
    uint256 constant IC2x = 2847316297453175523666781292620521906655998340730331421021138726051015128907;
    uint256 constant IC2y = 4822419334058431324174703905036955320258296641180035647810571054051837681247;
    
    uint256 constant IC3x = 15779343567257042490586952696982664635491491872659416011962960097954102755936;
    uint256 constant IC3y = 19900944192400528356811497225684219648267550989734132610158045710236340498662;
    
    uint256 constant IC4x = 12297805174079202804201459365552785435798873789611075212463936629569693263388;
    uint256 constant IC4y = 17190830305824808045010191768445608977021747107339718137424395108446338197270;
    
    uint256 constant IC5x = 5707004900090385898364720420525417679211194753056417653217305584195369008345;
    uint256 constant IC5y = 18423409797350054937332027873443692562093811697973496308516629669693428842830;
    
    uint256 constant IC6x = 15776802571365458512565756875465586168379518485319697267075013231277804090302;
    uint256 constant IC6y = 434175022407355619093077176634856974189824049548074946519710818079059422415;
    
    uint256 constant IC7x = 8863116851330125313575549178091195144668651139525428058711436170520936527687;
    uint256 constant IC7y = 14418784339552851099037821528254935170731710602823487020883646940881480227284;
    
    uint256 constant IC8x = 2950135295090821642345129659392484121306217660336254971385759261526169102513;
    uint256 constant IC8y = 3811532181507279721488361140199187677968606419704466691416611019695349005037;
    
    uint256 constant IC9x = 18471082541065902856654038397101688224908011167233209197618709940839829429950;
    uint256 constant IC9y = 4378133764468803874369178671481798136246560874890977014314877735093841384028;
    
    uint256 constant IC10x = 872621243042638384164482750313029201946268088912041170793277667005432345853;
    uint256 constant IC10y = 1731385790308260779589127452761295725394830543567381420052683922569277197716;
    
    uint256 constant IC11x = 6242860718503776494565656607948468583939677365210590461034295592975401299088;
    uint256 constant IC11y = 21489580080991654500614393376800161080799622144248569584576531196215554783870;
    
    uint256 constant IC12x = 4276637751776008781104208536885694001860189998461509165370241202084147189291;
    uint256 constant IC12y = 4919634958029076171070053791041166623490677304907075952692393764203826818830;
    
    uint256 constant IC13x = 6263638577718779624777540991564478127482252218485702981345585993185943682572;
    uint256 constant IC13y = 13907429896222431113391664429438027453562216690080606073741128163670906289566;
    
    uint256 constant IC14x = 1781869414093779478850271699999486276521242962269112079909783663737433468768;
    uint256 constant IC14y = 2407509860552455501832550187706857986137389299689250263009621693409431867625;
    
    uint256 constant IC15x = 6541487329107925628278662049589044136300410291195427417675474638042604670477;
    uint256 constant IC15y = 1905177704301203321843087631367133076958690361559159558367633303601040511161;
    
 
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

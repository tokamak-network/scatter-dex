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
    uint256 constant deltax1 = 21010370400435568673637719680102196744742346532756642564830851663322943283262;
    uint256 constant deltax2 = 2643495527748832890871368694367020916817134875046506341090908654680641014055;
    uint256 constant deltay1 = 7697469957846978484818100054402559074430783848783793184095355462642696729568;
    uint256 constant deltay2 = 20376081676242782600093897081287837496104491557279047880678102399423427360514;

    
    uint256 constant IC0x = 10339245670642057255511172935253821935139986936596359228359690398535324244724;
    uint256 constant IC0y = 18851360016225237893486021954436105252122353735052598437139573482411975301849;
    
    uint256 constant IC1x = 15598077381957612910863597076440245424390123702504356598855632887714011561917;
    uint256 constant IC1y = 17891042449418744106579474753556225864305576482912233103277271460334207563835;
    
    uint256 constant IC2x = 5713589941478453118909606234986210858799722375358028157414792071739575644457;
    uint256 constant IC2y = 10171325722831826615776196467028073875101623824449607287367413478767831456848;
    
    uint256 constant IC3x = 1809496266848505089633332286127501661797756489714118581242629928762421083154;
    uint256 constant IC3y = 10391579683383702595066680249094148591516525924736718349194414705556877415417;
    
    uint256 constant IC4x = 9834979909231296821793959504521008720275068837222653749846782943071832161906;
    uint256 constant IC4y = 2301473601897388531043738672508294955750414002657490985329746880995233863762;
    
    uint256 constant IC5x = 13877489204079149642350525259416030042150107964475391491684756731991711880165;
    uint256 constant IC5y = 5830399233920494794770663707107745513604464231418235870428057377959464827376;
    
    uint256 constant IC6x = 20920338698554531796431044225017914213338188800198860455582109829791891560398;
    uint256 constant IC6y = 15170081604148106450500645589234581404089943328107284083180743481530579432283;
    
    uint256 constant IC7x = 1975244011081851074256969942200141592987074980975671087238503299737611264656;
    uint256 constant IC7y = 13651635508139759647437408334029149100467478057332291973710293117879442291447;
    
    uint256 constant IC8x = 17575766408612275477794113001306849840651503320752476192451491002185306928767;
    uint256 constant IC8y = 7782518248279624587726078903190590937642935178299890629222718283786806849988;
    
    uint256 constant IC9x = 10628037090895363200508030156476301530017966933747836828532222050890425400614;
    uint256 constant IC9y = 2929283592584925929237801575460535306150257437663372071483744103386643066747;
    
    uint256 constant IC10x = 13807394921183343675766143066374920015989937189307695096779410274643317858457;
    uint256 constant IC10y = 1499243085253942412085430498487175223826202762034226472600493840934889425002;
    
    uint256 constant IC11x = 8597077537698124298616871564464941130341427532877469699163630188031135203332;
    uint256 constant IC11y = 13719894051010916831322597987819864384964183304715865672610935988104114749146;
    
    uint256 constant IC12x = 1870258798488739206381587783177895690418820912166449631224301916787239531823;
    uint256 constant IC12y = 2622510011574142214566362090066654817332439626193997942020593879521151832477;
    
    uint256 constant IC13x = 5407370743001496865312871623022927539996305004141241970365522591183788206552;
    uint256 constant IC13y = 7700249352568916414241365681992174301651747704367703965605197768781710266637;
    
    uint256 constant IC14x = 20530115733319778128625100254055053905020074478691790281156213318225726073083;
    uint256 constant IC14y = 12027500544070406059291337749972721949848282440764304069963564323397408768421;
    
    uint256 constant IC15x = 10089488960498409092974535127621833754971898835113766815425674877531655798498;
    uint256 constant IC15y = 20098958170952988153128659596373624577667200924873594040076843258416463423869;
    
 
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

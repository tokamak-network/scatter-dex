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
    uint256 constant deltax1 = 17130993230608984977463713417196409046779549193257749966684448477189923799764;
    uint256 constant deltax2 = 16071711296818473586087592655274927367183599524205044739129044508073887036418;
    uint256 constant deltay1 = 11456864001569967682626838655264636347320172661003418424651685717632614800501;
    uint256 constant deltay2 = 14130757330344433927150659033482034033258488285392468397867945525592235098052;

    
    uint256 constant IC0x = 20011114503910751520065048372815093289245927591885481707658019983206052429290;
    uint256 constant IC0y = 21151051501328926057966528688343003223900500521964183059753025356318909647860;
    
    uint256 constant IC1x = 7802789203629452849857345601060055171308430341133274908973796081695300550592;
    uint256 constant IC1y = 15530875673663761955858669765637912524617290829015285562768432082450356177604;
    
    uint256 constant IC2x = 1250186261776150154780621995132955545904319917224046031069545383524700565918;
    uint256 constant IC2y = 14512743301799859233808126969467234461682091089766000135370902409209625330013;
    
    uint256 constant IC3x = 11855084184554396444853324426520954699206014493461013218365284025625319555392;
    uint256 constant IC3y = 4689522353823364180418996693431645051774833594215339668500939361725298063786;
    
    uint256 constant IC4x = 14346285212105084165648037678853293819112813644012944128150800265983707246465;
    uint256 constant IC4y = 21298358598873799598200891602745870022909825828332723594208695002299962034159;
    
    uint256 constant IC5x = 20175766795980685564502293939955491705672282515526091103286866606106810415406;
    uint256 constant IC5y = 17526971233280013930343548807048794628983222228108567535228602279662538999148;
    
    uint256 constant IC6x = 8461556843673202193663416580366274547137095790988889997594208875796219154967;
    uint256 constant IC6y = 19275120773463511747537256718605267701338963434091900247315908405211938587046;
    
    uint256 constant IC7x = 6609924218661316510590803298454607897632244354327218309653210256139283746987;
    uint256 constant IC7y = 20990689574459189376341870928323217936928586031925911420239367453127596757763;
    
    uint256 constant IC8x = 8545580729148975305046427494767005392741786012795104063390569745645116226889;
    uint256 constant IC8y = 3771621344298429403535673010265743981747251320260122596850620592455516767227;
    
    uint256 constant IC9x = 13451784321661372793466284427906370459854856652180440645249625780260675895127;
    uint256 constant IC9y = 21577231300299034985641695775666926399725677440749121536822015034146782072994;
    
    uint256 constant IC10x = 4600136772495801208276417260559286809692919683374326848036858297947120761905;
    uint256 constant IC10y = 18731491694843917544598133260615154839449776713866907984874661626567415544344;
    
    uint256 constant IC11x = 20424229017510104589700998944090779058531015364774097531480506711054023532604;
    uint256 constant IC11y = 18964914411043332808446088447400024580479345713158415990066468905409990111399;
    
    uint256 constant IC12x = 20561054086446971900526813634019957483961472376532894108901386163107241810378;
    uint256 constant IC12y = 3650794469595152260358683494282068891982090394615681379768863517268000070541;
    
    uint256 constant IC13x = 11215801867896754144860478463336328718919836416608125996070613271572493879363;
    uint256 constant IC13y = 13868987337862717866803518297418356386976527939551408441431335219135088330401;
    
    uint256 constant IC14x = 16249589908713317495551252816566446754454651730899431584398184541557331402249;
    uint256 constant IC14y = 7960632582306475236420103644382918786705362461669514540279823234172077728906;
    
    uint256 constant IC15x = 6907083202288856847796612888720179232101189546616272700494009319661371376138;
    uint256 constant IC15y = 19344229563740206341405344685894400944484952099842963947955593024839387298269;
    
 
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

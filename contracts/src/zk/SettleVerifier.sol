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
    uint256 constant deltax1 = 13215879260998049308750166567638198645350197967161964833938018010961258055509;
    uint256 constant deltax2 = 3504932101766252933518966061051421324768023152997763946372432270577878496341;
    uint256 constant deltay1 = 12829628440347659938953704295475756171730698370213867223150731666810479128872;
    uint256 constant deltay2 = 2132235912012628765568916689710179134347923760093413721786591126919242638799;

    
    uint256 constant IC0x = 18643771354895326800130655811883842619955809827300573576218031237941594269702;
    uint256 constant IC0y = 18042001495513935676197222057636816652380057578385136264208602520184598916460;
    
    uint256 constant IC1x = 7698621336751064835589319054938187915860715436063829195706460040720963749809;
    uint256 constant IC1y = 17786614474170596892726608769795918488296439033795156460755467516688969755736;
    
    uint256 constant IC2x = 3783915654056748036414333508762471176950754985812181333342279884756088449433;
    uint256 constant IC2y = 8637595183742446602200489172561388019743067145191922724535097767743600953362;
    
    uint256 constant IC3x = 5268266793910084485222479815080150023077953556654699261229069004765136161826;
    uint256 constant IC3y = 5390173796804282975875297857852518166598713755486289155395506431565275894153;
    
    uint256 constant IC4x = 8582686994315142222780537788318090495505099768090391804150100173867461699530;
    uint256 constant IC4y = 12504870515379105364982319838648776366134398931629759399686907475045808896270;
    
    uint256 constant IC5x = 11933640948307041636561867595367575858767323353558885955918114455337553816767;
    uint256 constant IC5y = 3397467940889210882495784791000160335162799400070400625615872355628146068225;
    
    uint256 constant IC6x = 11488554992554218451131588356613634249440409160561256586180997359009137799406;
    uint256 constant IC6y = 20684501944247550197101796013142033158598780622265442418300046684929056715922;
    
    uint256 constant IC7x = 8659648432222886384547241630807461338496756837351951178649137985267209043127;
    uint256 constant IC7y = 15348913067715590751781602008414173607860168778879977926275378237179621495495;
    
    uint256 constant IC8x = 20104062446012493657809642931887134246079045082090462089831925499433244592888;
    uint256 constant IC8y = 6831207828576339815989370597533588349035521405470146470287018069517755692102;
    
    uint256 constant IC9x = 19825657616036584738132329726281922811789088487489233741203427851954076928810;
    uint256 constant IC9y = 5190957048218317483157723541947650318557128425759675764970118227503366109142;
    
    uint256 constant IC10x = 21173453468606672445349051657302281135261372187147320062230507913976967362171;
    uint256 constant IC10y = 7313801946016600424995304143293983020030666076473717157926730595335928214299;
    
    uint256 constant IC11x = 21079546141803083754829772207311322045628438032749473408557003650261374734355;
    uint256 constant IC11y = 1992705249207180739838730655263898851091493301386419224500865223835213139710;
    
    uint256 constant IC12x = 10101832666023847893099959807729498970682647739816481597956313370616101889161;
    uint256 constant IC12y = 9618052659044999149131402513560977681196109660242128597389386201127524399387;
    
    uint256 constant IC13x = 13464122459098647767363921970000303195361985993071233001344795718950725992435;
    uint256 constant IC13y = 3412312050935215202574207920320080374701343865018990706156151314406688172171;
    
    uint256 constant IC14x = 5189116611645286283781194124168340881287641225684070995036495670524429519402;
    uint256 constant IC14y = 814115769063143809119859806986032767993336827156710229161228294054631928728;
    
    uint256 constant IC15x = 4115425644179837259965765297233683134820431202413291580432779600711452089269;
    uint256 constant IC15y = 12951994608789721875564592885398968226350373625533547400422718104773744893393;
    
 
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

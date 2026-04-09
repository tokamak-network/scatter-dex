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
    uint256 constant deltax1 = 5052255918891330219072182778432693572001245471509984559173159610226916761335;
    uint256 constant deltax2 = 8752265752047856518154147750451592321925060509292132961029972407770954521297;
    uint256 constant deltay1 = 4012393833642895449082555456328162030472975393142200747418287556207579129350;
    uint256 constant deltay2 = 6438653640028876239971088786943345992907663619115674259228608400171755472854;

    
    uint256 constant IC0x = 13384689863959568337124937725735601171240390375214563102411591174157222139067;
    uint256 constant IC0y = 6502619093247296782653522026900015662369180684383554566970065044333594315117;
    
    uint256 constant IC1x = 8376462848916572685793389205164361503517396779056407512311306556800851153741;
    uint256 constant IC1y = 17291962236121254352365369921398949162433049566700161536071400742916260781988;
    
    uint256 constant IC2x = 4400249545784144983464973646065038266493319990187858670616834872143136331553;
    uint256 constant IC2y = 12300451148110609852963751507938347164098117603566249251663804480155254585205;
    
    uint256 constant IC3x = 14302899111571842375760762378102009336331075426371669009732858765613214496184;
    uint256 constant IC3y = 1323284271737989297439514675601490561597639887245255734122013274803907838234;
    
    uint256 constant IC4x = 9940490342411130222294259686485641995375027157364059143711348803219755338863;
    uint256 constant IC4y = 9983769237978437563286569972635320695239742118540783924868859202529235771887;
    
    uint256 constant IC5x = 4576730053903748427934635733084371866270951133077885206692902672031231518519;
    uint256 constant IC5y = 4676721954673353340175474007794661261253359668683354359282651429635227999172;
    
    uint256 constant IC6x = 15143159896316632034696004492744402646795897964875894465815668728558589182238;
    uint256 constant IC6y = 10148078929865454330006092507980749888709998241531512977025564492188073754676;
    
    uint256 constant IC7x = 13463509519214897380045937166847606359390065980889868098822558712590884641680;
    uint256 constant IC7y = 18313132540035375639442860266103027442814386772979525650776501826536414775923;
    
    uint256 constant IC8x = 18981652484785650262292335750854150328085462904893026572346707930918385227395;
    uint256 constant IC8y = 16892946980309548715608837968587715961211358945165772004891127797492977788280;
    
    uint256 constant IC9x = 8637274605970863181465826334085144339179052169517246768068674203056748948065;
    uint256 constant IC9y = 10873935587352714644689832910350166317597825768174812858365577621622450277131;
    
    uint256 constant IC10x = 9844511567943178493315892199964530506004881690597760145321732430043458234695;
    uint256 constant IC10y = 6079633823939109697640116547060861003022350161582810507312129519062699030637;
    
    uint256 constant IC11x = 14078360841114792684660246658553814997520134499329618556481105980281451770593;
    uint256 constant IC11y = 17009157099941311630521996265921466691473788072042701351710982844184685412552;
    
    uint256 constant IC12x = 6924006196094113598980502734278172937809404323176253541583245150265287557676;
    uint256 constant IC12y = 8300460523839611802419548390539677287951590818134977104783704042799470258745;
    
    uint256 constant IC13x = 10516334119120919600601258711419439761678337182204794254462890823329886246055;
    uint256 constant IC13y = 2284955378466112883187065692341260646365776972753278304056445893117322490413;
    
    uint256 constant IC14x = 10730672491950933296757806918458540780332824305914298944648788461786171250946;
    uint256 constant IC14y = 4809275485327998415406251586848449592615860128431671504758709130459857585822;
    
    uint256 constant IC15x = 11294983795340509207164375792334116414380784643758074912181154833436615704009;
    uint256 constant IC15y = 5509812844333285720448417135761044374771851585195355871103236598354972764852;
    
    uint256 constant IC16x = 5975177906817141314030847065288510472928463913621209351939951266245692195740;
    uint256 constant IC16y = 5312039512756780086641962190524193747571296403050543068959821196356638627523;
    
    uint256 constant IC17x = 5818947866243847983659430565170426311756382279978015520923987857949592245637;
    uint256 constant IC17y = 13763293723999115765309349505001149206808506416384800346198278229094971366649;
    
    uint256 constant IC18x = 12383156424176673618284012885666415132106724624504874313527313742402723322352;
    uint256 constant IC18y = 19349142364227479656943970427783740012221983019648062108374692022460741151531;
    
 
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

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
    uint256 constant alphax  = 7973305246785442811323710485736577828558736294171365974102765901685021039038;
    uint256 constant alphay  = 6835538200504280419657946622290107664485809636897816330284715576148974415644;
    uint256 constant betax1  = 12217080092075455180197866090064651088590295928594548176613685433283701293619;
    uint256 constant betax2  = 7755352787843551131418498318895043392648533877650001978044214611210353073595;
    uint256 constant betay1  = 14194709622206353185944462510310627720557886361337522055006288474817497545099;
    uint256 constant betay2  = 20754555830103870524817503340713913504615110246835207849326979095791666980048;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 8683037897138491310324791646184932130452046062261291469735486482702126050181;
    uint256 constant deltax2 = 7659593437307561320032453742895224457373583533473772792369969200795151035435;
    uint256 constant deltay1 = 21039604156544779642741647503739621110590563807962111358781844249032780292220;
    uint256 constant deltay2 = 13422165630605272080683948753052003528326174749805669140927822589325768399321;

    
    uint256 constant IC0x = 18096360171003743710086671738274639249226185301897308099269805260158978422923;
    uint256 constant IC0y = 12331912213876650169152161896121036699507034286242755778909485918430666233444;
    
    uint256 constant IC1x = 10995602496748475980696413199546195858862140926093154457471252041503755299511;
    uint256 constant IC1y = 18353634508446198582959649870649573791288468755268869480763886407131096084266;
    
    uint256 constant IC2x = 9118984869449243264398857895174305621971501763761096979667687096708005603916;
    uint256 constant IC2y = 10100234688002275149506391097969412205482189729829644694947742118976246258854;
    
    uint256 constant IC3x = 2639741710423247229756397631803586595019308131204726059801158081740673974564;
    uint256 constant IC3y = 18332340171835327245932566577223085781941669166943706922121962031831326820989;
    
    uint256 constant IC4x = 20062077104591576119283504397045442935567850702116543649644799407586607117423;
    uint256 constant IC4y = 18236314474569930009403525332459055823878487862525550911782017005200157926556;
    
    uint256 constant IC5x = 19881824758047643340851877335444098075609272564273741616298865356519015986159;
    uint256 constant IC5y = 2359884911468148454864877098138509540668487049360227006321895527058865928902;
    
    uint256 constant IC6x = 17768367475392915858256811094222808081595567533287452820329775156177349191589;
    uint256 constant IC6y = 16002581509979358202986457922256131255504055529403592609434908388218718468880;
    
    uint256 constant IC7x = 8337476829110810203308918842798921136131289736962648898731042081006374533650;
    uint256 constant IC7y = 14173899624209072848565221877391050133006394965365461991980377555704106544223;
    
    uint256 constant IC8x = 7416372336611937899857661930435672635572996140660199595230013317434647858193;
    uint256 constant IC8y = 9907384433691920350753133099177757398134754606957047420976560019683203506384;
    
    uint256 constant IC9x = 5045036457819650673683069254606850834181496146327615170787619866127592519487;
    uint256 constant IC9y = 5382661423858400308088957711241886882721715026696378312921183245901165366543;
    
    uint256 constant IC10x = 9436503745533051141576239973822131305287878052307248939550927871166627689157;
    uint256 constant IC10y = 17659601042730759238013989904982953297666579603213013793685610726904246467846;
    
    uint256 constant IC11x = 14971538405606717905534704503637914267066615219760429905004468688611628005384;
    uint256 constant IC11y = 17771731641092399748676271060034840883150785251541955300171514665427974909748;
    
    uint256 constant IC12x = 11940235329374743582045601389915545835404243277438873492937732273545214684178;
    uint256 constant IC12y = 9874581744474928955102588632144805702176014632057345436042845016298176207333;
    
    uint256 constant IC13x = 8577114958670685985443656706786414502766486943035519826556055058400498363459;
    uint256 constant IC13y = 2732280212841985025314758298080382651850775907895723630839558012435125102752;
    
    uint256 constant IC14x = 7754044838028401698051519461446388506186725554626301456323581259060237373250;
    uint256 constant IC14y = 18919767545074510989755191702461687077519326299116816992291733947706542294022;
    
    uint256 constant IC15x = 14162938357780952109272852007148349201175894522701394967368489630514394919336;
    uint256 constant IC15y = 19656389593828527230055577299464547404899624743741719583895584509657200134661;
    
    uint256 constant IC16x = 20307013706066448475493820109131349642138784660657298378435292223671463774488;
    uint256 constant IC16y = 8021440653672061979191781031113798678245912406527630998804698307001627215590;
    
    uint256 constant IC17x = 9530709640097901795175263688961955433435571375265963983767927902815231231452;
    uint256 constant IC17y = 10168751087742946561702387402666092971584379385410429009392916420343980440037;
    
    uint256 constant IC18x = 16611468879786142970570889587730267954669193002377445654688341944666351212875;
    uint256 constant IC18y = 1262232945112344431012907021531389205566697190419075069949131691745817016183;
    
 
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

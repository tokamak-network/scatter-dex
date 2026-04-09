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
    uint256 constant deltax1 = 6092636742354912342901569765435998244618027138528491600139156309051300196692;
    uint256 constant deltax2 = 6158347988420964943309234999079474360860297937023053772531413027892919338777;
    uint256 constant deltay1 = 9802094075289313835745409912039621965809923609897701340214031503203598804069;
    uint256 constant deltay2 = 9897932404978754280579727469769376460375724384886550636567003003378909173123;

    
    uint256 constant IC0x = 15978735127024150785412511162933698279038600442685675010558263887315177729178;
    uint256 constant IC0y = 13468955302665793362711703431858494416030725899481821500184859286568687775272;
    
    uint256 constant IC1x = 17301732784309589810881105145311020242136865625332567709447652666782077538483;
    uint256 constant IC1y = 8687450238049018925997829819098597531651657260967336451264506125487438519749;
    
    uint256 constant IC2x = 9760914915375985969636982021352616246246514696039937496474326212890985165753;
    uint256 constant IC2y = 6131772976954875708884184212738533952114047550574524868624014831649137289278;
    
    uint256 constant IC3x = 20604873504595386757877354853025357417247613029536245763751382578974965594252;
    uint256 constant IC3y = 6140227844371315109343701423468920349463535761043784591729355731574491698117;
    
    uint256 constant IC4x = 6388928272031542195935320813599236979344249344761637676922835229956180772843;
    uint256 constant IC4y = 11639625325301601337080877303093311965080790679284756167684371838806079059579;
    
    uint256 constant IC5x = 10032297653733765251567763205084361669666639127178586059468894750296784337515;
    uint256 constant IC5y = 8004513988599541262593847576397270292450576027199769350795570104149237965068;
    
    uint256 constant IC6x = 18090997261848166057781837742911296508685126521541478473206145753722152879770;
    uint256 constant IC6y = 6766946333654567114531008924230839130201660057844491963399041645306791619074;
    
    uint256 constant IC7x = 16346907956199549620576251383074918208128584346706664651839407673527058859673;
    uint256 constant IC7y = 15831415434294511995123971122967159387439415367515129419311114103483959648610;
    
    uint256 constant IC8x = 17062188187969151850130007037771867311760481691852254743825035124646319164535;
    uint256 constant IC8y = 6129055384970657349550980158135580178082805497423038153528167381713889771054;
    
    uint256 constant IC9x = 20816872987047828108613824497677123708886308785181943015479575858617656800002;
    uint256 constant IC9y = 17861609283850986286496470493191803131069295666410336169065300449576473472791;
    
    uint256 constant IC10x = 846125413493942853548463012421551369744070198365677118728073670079025471394;
    uint256 constant IC10y = 20063583578541567256398628839869305215131575119568714805182795935808949448957;
    
    uint256 constant IC11x = 7541257530755739633960474183499678663598651350426609097235554543197396947838;
    uint256 constant IC11y = 20489540493268565693608406422019701786665965316728483732551695451554188107846;
    
    uint256 constant IC12x = 20933211151504797097271016265158237642147645221244768170463614515448566016109;
    uint256 constant IC12y = 8847200869338833112492391704989187444063813209954948273881436470086343906507;
    
    uint256 constant IC13x = 16514218075421880823085935802118723319694537870898768881053165050935404638867;
    uint256 constant IC13y = 13250444472952082953491810717301089537028272552127984706294865054131262829713;
    
    uint256 constant IC14x = 20951561204755521743965380645427450413329522350536569312056949650550378341667;
    uint256 constant IC14y = 6960250394843968737318556346266171918645726357890911089268490326268304728789;
    
    uint256 constant IC15x = 3435106320579676237783927003910991977313354683134253141006900704251653351185;
    uint256 constant IC15y = 12180749991914433335515245689178774289401662759534151908658916323480928795176;
    
    uint256 constant IC16x = 2685118731639709740496105194606768660413454740341113624483615442160520401221;
    uint256 constant IC16y = 20142695627474767614464276592322466995373231170651482224944643822259174694442;
    
    uint256 constant IC17x = 7346451698729814341470291990886388007875045019570262464212306916770921259238;
    uint256 constant IC17y = 19595774703367200588457376183822681404440198299153963347659792874438018889347;
    
    uint256 constant IC18x = 7033114230073727010923899130861314758815082856725319914794160933456848872057;
    uint256 constant IC18y = 18469457508240695879062942064472237925367562968695848563889656652820120359760;
    
 
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

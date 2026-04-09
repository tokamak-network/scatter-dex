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
    uint256 constant deltax1 = 11800605014429010268115216307682826535776417791921284926733199346439454746026;
    uint256 constant deltax2 = 460241583222865540156092611979225664839699055873707664106379644237733164386;
    uint256 constant deltay1 = 7928744902034220882946464827287058777503143081567248739167061514282622952430;
    uint256 constant deltay2 = 5759980567192815130036855743057732595731171691218521012357258717001575512920;

    
    uint256 constant IC0x = 17910798241713169031295012036352430378777319063575183567441050231184783048716;
    uint256 constant IC0y = 19098586811763608158665158059939767739987985838902723984617167949318021861196;
    
    uint256 constant IC1x = 7738023484101177886240589699900039765494788067898800586239321870980879665113;
    uint256 constant IC1y = 11632547694909784895368956690197329958105120421901226427495056319113910851112;
    
    uint256 constant IC2x = 13912869079642051132782209281763159641785597742436526266397308135225649174334;
    uint256 constant IC2y = 14902120831976497098712505111144805160988351398025830472930350794145341323218;
    
    uint256 constant IC3x = 9344939191724104163741139144630909838645046472159326710254375704599549142710;
    uint256 constant IC3y = 2801278427634728467573195155406722167043330439928288312296707211776091151077;
    
    uint256 constant IC4x = 16216015577251395048946197692544954649184966319868280135343507986525095877045;
    uint256 constant IC4y = 9290532011021374390564804690789083826394035547292433193184194335711889525017;
    
    uint256 constant IC5x = 17095503004918730350582950400419844943468096177892944854644308245281462156824;
    uint256 constant IC5y = 17110990171186588989314991664438074784104683557493113241860748416158167927723;
    
    uint256 constant IC6x = 11946496493322132811390962373911023372939913307066069412773746774023745330445;
    uint256 constant IC6y = 14534403965676995952284365254592775371035935478547256404547926166099341541687;
    
    uint256 constant IC7x = 4544566429128542248543961341731812963920722906468682629778328942014540685244;
    uint256 constant IC7y = 7178339884743079546669902434734239341822974127959228350153152792318399305660;
    
    uint256 constant IC8x = 5621398569474719458378944710906206029847824909160225019495452654802659665369;
    uint256 constant IC8y = 16747499868023651084829006490545623213367940178784381815047192018364612336207;
    
    uint256 constant IC9x = 2446658995709366231868745098715221988557460812116124954965756938074457997996;
    uint256 constant IC9y = 3049002145563518790462391568603097949373899753226816015924346003729212239932;
    
    uint256 constant IC10x = 6839710084145176308106782863789418976623026877573327272352213075637335807005;
    uint256 constant IC10y = 20618242026101242076885091388942037840675499650342618168540867770400001187007;
    
    uint256 constant IC11x = 10393572963500605216632688806252258903086306293732509506562422058629212977921;
    uint256 constant IC11y = 17392534497116626063647587118212200463538238908103732935593287179861375947481;
    
    uint256 constant IC12x = 6714552594321700638979967461401895510616381297650364197673918648344576947540;
    uint256 constant IC12y = 9386869624594679085009360301365003506565209259105165704594457629254634706909;
    
    uint256 constant IC13x = 12927507614205181430200431107046844280915115935984807840441723371734515246550;
    uint256 constant IC13y = 7813690488404496375161341780624895835603038686456200651402491372159873318020;
    
    uint256 constant IC14x = 21601232034251206051167656780821070602559057226658909222524606118842234329914;
    uint256 constant IC14y = 19646091626953060821912848190577709115776636735658867627118018075396687653390;
    
    uint256 constant IC15x = 3681979559519320384418554980670444932297362550495683887136135015177739952910;
    uint256 constant IC15y = 2179454353518667982960922625717757611225643606026516234615975902477003381346;
    
    uint256 constant IC16x = 2910923992703717346649787459577102481902550107108143937275348688172953493051;
    uint256 constant IC16y = 11403196725932547463493783786537716510641775136639128949828546939151411073059;
    
    uint256 constant IC17x = 3685188707119245482186391641263323144962055994017039083076357077700285860259;
    uint256 constant IC17y = 9314287494136308145836227352817542492410826141907427447145002579617562216770;
    
    uint256 constant IC18x = 7754924272643836721785222990151855276776121962240464600966055124940828146020;
    uint256 constant IC18y = 13463938299034528283888629642203668130487574502483758768929945671479253250250;
    
 
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

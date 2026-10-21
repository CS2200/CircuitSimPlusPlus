{
  "format": "circuitsim-plus-plus",
  "version": 5,
  "name": "alu",
  "settings": {
    "clockHz": 1,
    "delayTable": "cs2200-74ls-v1"
  },
  "circuits": [
    {
      "name": "main",
      "components": [
        {
          "id": "a",
          "type": "wiring.pin",
          "pos": [
            0,
            0
          ],
          "name": "a",
          "attrs": {
            "bitsize": 32
          }
        },
        {
          "id": "b",
          "type": "wiring.pin",
          "pos": [
            0,
            0
          ],
          "name": "b",
          "attrs": {
            "bitsize": 32
          }
        },
        {
          "id": "op",
          "type": "wiring.pin",
          "pos": [
            0,
            0
          ],
          "name": "op",
          "attrs": {
            "bitsize": 3
          }
        },
        {
          "id": "y",
          "type": "wiring.probe",
          "pos": [
            0,
            0
          ],
          "name": "y",
          "attrs": {
            "bitsize": 32
          }
        },
        {
          "id": "zero",
          "type": "wiring.probe",
          "pos": [
            0,
            0
          ],
          "name": "zero"
        },
        {
          "id": "adder0",
          "type": "arith.adder",
          "pos": [
            0,
            0
          ],
          "attrs": {
            "bitsize": 32
          }
        },
        {
          "id": "constant0",
          "type": "wiring.constant",
          "pos": [
            0,
            0
          ],
          "attrs": {
            "value": "0"
          }
        },
        {
          "id": "nand0",
          "type": "gate.nand",
          "pos": [
            0,
            0
          ],
          "attrs": {
            "bitsize": 32
          }
        },
        {
          "id": "splitter0",
          "type": "wiring.splitter",
          "pos": [
            0,
            0
          ],
          "attrs": {
            "splits": {
              "shamt": [
                0,
                1,
                2,
                3,
                4
              ],
              "hi": [
                5,
                6,
                7,
                8,
                9,
                10,
                11,
                12,
                13,
                14,
                15,
                16,
                17,
                18,
                19,
                20,
                21,
                22,
                23,
                24,
                25,
                26,
                27,
                28,
                29,
                30,
                31
              ]
            }
          }
        },
        {
          "id": "shifter0",
          "type": "arith.shifter",
          "pos": [
            0,
            0
          ],
          "attrs": {
            "bitsize": 32,
            "shift": "ll"
          }
        },
        {
          "id": "shifter1",
          "type": "arith.shifter",
          "pos": [
            0,
            0
          ],
          "attrs": {
            "bitsize": 32,
            "shift": "lr"
          }
        },
        {
          "id": "mux0",
          "type": "plexers.mux",
          "pos": [
            0,
            0
          ],
          "attrs": {
            "bitsize": 32,
            "selectBits": 3
          }
        },
        {
          "id": "splitter1",
          "type": "wiring.splitter",
          "pos": [
            0,
            0
          ],
          "attrs": {
            "splits": {
              "b0": [
                0
              ],
              "b1": [
                1
              ],
              "b2": [
                2
              ],
              "b3": [
                3
              ],
              "b4": [
                4
              ],
              "b5": [
                5
              ],
              "b6": [
                6
              ],
              "b7": [
                7
              ],
              "b8": [
                8
              ],
              "b9": [
                9
              ],
              "b10": [
                10
              ],
              "b11": [
                11
              ],
              "b12": [
                12
              ],
              "b13": [
                13
              ],
              "b14": [
                14
              ],
              "b15": [
                15
              ],
              "b16": [
                16
              ],
              "b17": [
                17
              ],
              "b18": [
                18
              ],
              "b19": [
                19
              ],
              "b20": [
                20
              ],
              "b21": [
                21
              ],
              "b22": [
                22
              ],
              "b23": [
                23
              ],
              "b24": [
                24
              ],
              "b25": [
                25
              ],
              "b26": [
                26
              ],
              "b27": [
                27
              ],
              "b28": [
                28
              ],
              "b29": [
                29
              ],
              "b30": [
                30
              ],
              "b31": [
                31
              ]
            }
          }
        },
        {
          "id": "nor0",
          "type": "gate.nor",
          "pos": [
            0,
            0
          ],
          "attrs": {
            "inputs": 32
          }
        }
      ],
      "wires": [
        {
          "a": {
            "comp": "a",
            "pin": "pin"
          },
          "b": {
            "comp": "adder0",
            "pin": "a"
          }
        },
        {
          "a": {
            "comp": "b",
            "pin": "pin"
          },
          "b": {
            "comp": "adder0",
            "pin": "b"
          }
        },
        {
          "a": {
            "comp": "constant0",
            "pin": "out"
          },
          "b": {
            "comp": "adder0",
            "pin": "cin"
          }
        },
        {
          "a": {
            "comp": "a",
            "pin": "pin"
          },
          "b": {
            "comp": "nand0",
            "pin": "in0"
          }
        },
        {
          "a": {
            "comp": "b",
            "pin": "pin"
          },
          "b": {
            "comp": "nand0",
            "pin": "in1"
          }
        },
        {
          "a": {
            "comp": "b",
            "pin": "pin"
          },
          "b": {
            "comp": "splitter0",
            "pin": "bus"
          }
        },
        {
          "a": {
            "comp": "a",
            "pin": "pin"
          },
          "b": {
            "comp": "shifter0",
            "pin": "in"
          }
        },
        {
          "a": {
            "comp": "splitter0",
            "pin": "shamt"
          },
          "b": {
            "comp": "shifter0",
            "pin": "amt"
          }
        },
        {
          "a": {
            "comp": "a",
            "pin": "pin"
          },
          "b": {
            "comp": "shifter1",
            "pin": "in"
          }
        },
        {
          "a": {
            "comp": "splitter0",
            "pin": "shamt"
          },
          "b": {
            "comp": "shifter1",
            "pin": "amt"
          }
        },
        {
          "a": {
            "comp": "adder0",
            "pin": "out"
          },
          "b": {
            "comp": "mux0",
            "pin": "in0"
          }
        },
        {
          "a": {
            "comp": "nand0",
            "pin": "out"
          },
          "b": {
            "comp": "mux0",
            "pin": "in1"
          }
        },
        {
          "a": {
            "comp": "shifter0",
            "pin": "out"
          },
          "b": {
            "comp": "mux0",
            "pin": "in2"
          }
        },
        {
          "a": {
            "comp": "shifter1",
            "pin": "out"
          },
          "b": {
            "comp": "mux0",
            "pin": "in3"
          }
        },
        {
          "a": {
            "comp": "a",
            "pin": "pin"
          },
          "b": {
            "comp": "mux0",
            "pin": "in4"
          }
        },
        {
          "a": {
            "comp": "b",
            "pin": "pin"
          },
          "b": {
            "comp": "mux0",
            "pin": "in5"
          }
        },
        {
          "a": {
            "comp": "a",
            "pin": "pin"
          },
          "b": {
            "comp": "mux0",
            "pin": "in6"
          }
        },
        {
          "a": {
            "comp": "a",
            "pin": "pin"
          },
          "b": {
            "comp": "mux0",
            "pin": "in7"
          }
        },
        {
          "a": {
            "comp": "op",
            "pin": "pin"
          },
          "b": {
            "comp": "mux0",
            "pin": "sel"
          }
        },
        {
          "a": {
            "comp": "mux0",
            "pin": "out"
          },
          "b": {
            "comp": "y",
            "pin": "in"
          }
        },
        {
          "a": {
            "comp": "mux0",
            "pin": "out"
          },
          "b": {
            "comp": "splitter1",
            "pin": "bus"
          }
        },
        {
          "a": {
            "comp": "splitter1",
            "pin": "b0"
          },
          "b": {
            "comp": "nor0",
            "pin": "in0"
          }
        },
        {
          "a": {
            "comp": "splitter1",
            "pin": "b1"
          },
          "b": {
            "comp": "nor0",
            "pin": "in1"
          }
        },
        {
          "a": {
            "comp": "splitter1",
            "pin": "b2"
          },
          "b": {
            "comp": "nor0",
            "pin": "in2"
          }
        },
        {
          "a": {
            "comp": "splitter1",
            "pin": "b3"
          },
          "b": {
            "comp": "nor0",
            "pin": "in3"
          }
        },
        {
          "a": {
            "comp": "splitter1",
            "pin": "b4"
          },
          "b": {
            "comp": "nor0",
            "pin": "in4"
          }
        },
        {
          "a": {
            "comp": "splitter1",
            "pin": "b5"
          },
          "b": {
            "comp": "nor0",
            "pin": "in5"
          }
        },
        {
          "a": {
            "comp": "splitter1",
            "pin": "b6"
          },
          "b": {
            "comp": "nor0",
            "pin": "in6"
          }
        },
        {
          "a": {
            "comp": "splitter1",
            "pin": "b7"
          },
          "b": {
            "comp": "nor0",
            "pin": "in7"
          }
        },
        {
          "a": {
            "comp": "splitter1",
            "pin": "b8"
          },
          "b": {
            "comp": "nor0",
            "pin": "in8"
          }
        },
        {
          "a": {
            "comp": "splitter1",
            "pin": "b9"
          },
          "b": {
            "comp": "nor0",
            "pin": "in9"
          }
        },
        {
          "a": {
            "comp": "splitter1",
            "pin": "b10"
          },
          "b": {
            "comp": "nor0",
            "pin": "in10"
          }
        },
        {
          "a": {
            "comp": "splitter1",
            "pin": "b11"
          },
          "b": {
            "comp": "nor0",
            "pin": "in11"
          }
        },
        {
          "a": {
            "comp": "splitter1",
            "pin": "b12"
          },
          "b": {
            "comp": "nor0",
            "pin": "in12"
          }
        },
        {
          "a": {
            "comp": "splitter1",
            "pin": "b13"
          },
          "b": {
            "comp": "nor0",
            "pin": "in13"
          }
        },
        {
          "a": {
            "comp": "splitter1",
            "pin": "b14"
          },
          "b": {
            "comp": "nor0",
            "pin": "in14"
          }
        },
        {
          "a": {
            "comp": "splitter1",
            "pin": "b15"
          },
          "b": {
            "comp": "nor0",
            "pin": "in15"
          }
        },
        {
          "a": {
            "comp": "splitter1",
            "pin": "b16"
          },
          "b": {
            "comp": "nor0",
            "pin": "in16"
          }
        },
        {
          "a": {
            "comp": "splitter1",
            "pin": "b17"
          },
          "b": {
            "comp": "nor0",
            "pin": "in17"
          }
        },
        {
          "a": {
            "comp": "splitter1",
            "pin": "b18"
          },
          "b": {
            "comp": "nor0",
            "pin": "in18"
          }
        },
        {
          "a": {
            "comp": "splitter1",
            "pin": "b19"
          },
          "b": {
            "comp": "nor0",
            "pin": "in19"
          }
        },
        {
          "a": {
            "comp": "splitter1",
            "pin": "b20"
          },
          "b": {
            "comp": "nor0",
            "pin": "in20"
          }
        },
        {
          "a": {
            "comp": "splitter1",
            "pin": "b21"
          },
          "b": {
            "comp": "nor0",
            "pin": "in21"
          }
        },
        {
          "a": {
            "comp": "splitter1",
            "pin": "b22"
          },
          "b": {
            "comp": "nor0",
            "pin": "in22"
          }
        },
        {
          "a": {
            "comp": "splitter1",
            "pin": "b23"
          },
          "b": {
            "comp": "nor0",
            "pin": "in23"
          }
        },
        {
          "a": {
            "comp": "splitter1",
            "pin": "b24"
          },
          "b": {
            "comp": "nor0",
            "pin": "in24"
          }
        },
        {
          "a": {
            "comp": "splitter1",
            "pin": "b25"
          },
          "b": {
            "comp": "nor0",
            "pin": "in25"
          }
        },
        {
          "a": {
            "comp": "splitter1",
            "pin": "b26"
          },
          "b": {
            "comp": "nor0",
            "pin": "in26"
          }
        },
        {
          "a": {
            "comp": "splitter1",
            "pin": "b27"
          },
          "b": {
            "comp": "nor0",
            "pin": "in27"
          }
        },
        {
          "a": {
            "comp": "splitter1",
            "pin": "b28"
          },
          "b": {
            "comp": "nor0",
            "pin": "in28"
          }
        },
        {
          "a": {
            "comp": "splitter1",
            "pin": "b29"
          },
          "b": {
            "comp": "nor0",
            "pin": "in29"
          }
        },
        {
          "a": {
            "comp": "splitter1",
            "pin": "b30"
          },
          "b": {
            "comp": "nor0",
            "pin": "in30"
          }
        },
        {
          "a": {
            "comp": "splitter1",
            "pin": "b31"
          },
          "b": {
            "comp": "nor0",
            "pin": "in31"
          }
        },
        {
          "a": {
            "comp": "nor0",
            "pin": "out"
          },
          "b": {
            "comp": "zero",
            "pin": "in"
          }
        }
      ]
    }
  ]
}

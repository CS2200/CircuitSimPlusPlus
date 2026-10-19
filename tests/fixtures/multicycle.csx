{
  "format": "circuitsim-plus-plus",
  "version": 3,
  "name": "multicycle",
  "settings": {
    "clockHz": 1,
    "delayTable": "cs2200-74ls-v1"
  },
  "circuits": [
    {
      "name": "main",
      "components": [
        {
          "id": "clk",
          "type": "wiring.clock",
          "pos": [
            0,
            0
          ]
        },
        {
          "id": "constant0",
          "type": "wiring.constant",
          "pos": [
            0,
            0
          ],
          "attrs": {
            "value": "1"
          }
        },
        {
          "id": "constant1",
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
          "id": "register0",
          "type": "mem.register",
          "pos": [
            0,
            0
          ],
          "name": "pc",
          "attrs": {
            "bitsize": 32
          }
        },
        {
          "id": "register1",
          "type": "mem.register",
          "pos": [
            0,
            0
          ],
          "name": "ir",
          "attrs": {
            "bitsize": 32
          }
        },
        {
          "id": "register2",
          "type": "mem.register",
          "pos": [
            0,
            0
          ],
          "attrs": {
            "bitsize": 32
          }
        },
        {
          "id": "register3",
          "type": "mem.register",
          "pos": [
            0,
            0
          ],
          "attrs": {
            "bitsize": 32
          }
        },
        {
          "id": "register4",
          "type": "mem.register",
          "pos": [
            0,
            0
          ],
          "attrs": {
            "bitsize": 32
          }
        },
        {
          "id": "register5",
          "type": "mem.register",
          "pos": [
            0,
            0
          ],
          "attrs": {
            "bitsize": 32
          }
        },
        {
          "id": "register6",
          "type": "mem.register",
          "pos": [
            0,
            0
          ],
          "name": "ustate",
          "attrs": {
            "bitsize": 4
          }
        },
        {
          "id": "rom0",
          "type": "mem.rom",
          "pos": [
            0,
            0
          ],
          "name": "imem",
          "attrs": {
            "bitsize": 32,
            "depth": 256,
            "autoload": "program.hex",
            "contents": "42000000 44000005 46000001 a0640003 02260000 46600001 a001fffc 80020000 68000000 0a820000 c0000000"
          }
        },
        {
          "id": "ram0",
          "type": "mem.ram",
          "pos": [
            0,
            0
          ],
          "name": "dmem",
          "attrs": {
            "bitsize": 32,
            "depth": 256
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
              "lo": [
                0,
                1,
                2,
                3,
                4,
                5,
                6,
                7
              ],
              "hi": [
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
          "id": "splitter1",
          "type": "wiring.splitter",
          "pos": [
            0,
            0
          ],
          "attrs": {
            "splits": {
              "lo": [
                0,
                1,
                2,
                3,
                4,
                5,
                6,
                7
              ],
              "hi": [
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
          "id": "splitter2",
          "type": "wiring.splitter",
          "pos": [
            0,
            0
          ],
          "attrs": {
            "splits": {
              "op": [
                29,
                30,
                31
              ],
              "rd": [
                25,
                26,
                27,
                28
              ],
              "rs": [
                21,
                22,
                23,
                24
              ],
              "rt": [
                17,
                18,
                19,
                20
              ],
              "imm": [
                0,
                1,
                2,
                3,
                4,
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
                16
              ]
            }
          }
        },
        {
          "id": "register7",
          "type": "mem.register",
          "pos": [
            0,
            0
          ],
          "name": "r0",
          "attrs": {
            "bitsize": 32
          }
        },
        {
          "id": "register8",
          "type": "mem.register",
          "pos": [
            0,
            0
          ],
          "name": "r1",
          "attrs": {
            "bitsize": 32
          }
        },
        {
          "id": "register9",
          "type": "mem.register",
          "pos": [
            0,
            0
          ],
          "name": "r2",
          "attrs": {
            "bitsize": 32
          }
        },
        {
          "id": "register10",
          "type": "mem.register",
          "pos": [
            0,
            0
          ],
          "name": "r3",
          "attrs": {
            "bitsize": 32
          }
        },
        {
          "id": "register11",
          "type": "mem.register",
          "pos": [
            0,
            0
          ],
          "name": "r4",
          "attrs": {
            "bitsize": 32
          }
        },
        {
          "id": "register12",
          "type": "mem.register",
          "pos": [
            0,
            0
          ],
          "name": "r5",
          "attrs": {
            "bitsize": 32
          }
        },
        {
          "id": "register13",
          "type": "mem.register",
          "pos": [
            0,
            0
          ],
          "name": "r6",
          "attrs": {
            "bitsize": 32
          }
        },
        {
          "id": "register14",
          "type": "mem.register",
          "pos": [
            0,
            0
          ],
          "name": "r7",
          "attrs": {
            "bitsize": 32
          }
        },
        {
          "id": "register15",
          "type": "mem.register",
          "pos": [
            0,
            0
          ],
          "name": "r8",
          "attrs": {
            "bitsize": 32
          }
        },
        {
          "id": "register16",
          "type": "mem.register",
          "pos": [
            0,
            0
          ],
          "name": "r9",
          "attrs": {
            "bitsize": 32
          }
        },
        {
          "id": "register17",
          "type": "mem.register",
          "pos": [
            0,
            0
          ],
          "name": "r10",
          "attrs": {
            "bitsize": 32
          }
        },
        {
          "id": "register18",
          "type": "mem.register",
          "pos": [
            0,
            0
          ],
          "name": "r11",
          "attrs": {
            "bitsize": 32
          }
        },
        {
          "id": "register19",
          "type": "mem.register",
          "pos": [
            0,
            0
          ],
          "name": "r12",
          "attrs": {
            "bitsize": 32
          }
        },
        {
          "id": "register20",
          "type": "mem.register",
          "pos": [
            0,
            0
          ],
          "name": "r13",
          "attrs": {
            "bitsize": 32
          }
        },
        {
          "id": "register21",
          "type": "mem.register",
          "pos": [
            0,
            0
          ],
          "name": "r14",
          "attrs": {
            "bitsize": 32
          }
        },
        {
          "id": "register22",
          "type": "mem.register",
          "pos": [
            0,
            0
          ],
          "name": "r15",
          "attrs": {
            "bitsize": 32
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
            "selectBits": 4
          }
        },
        {
          "id": "mux1",
          "type": "plexers.mux",
          "pos": [
            0,
            0
          ],
          "attrs": {
            "bitsize": 32,
            "selectBits": 4
          }
        },
        {
          "id": "mux2",
          "type": "plexers.mux",
          "pos": [
            0,
            0
          ],
          "attrs": {
            "bitsize": 32
          }
        },
        {
          "id": "decoder0",
          "type": "plexers.decoder",
          "pos": [
            0,
            0
          ],
          "attrs": {
            "inputBits": 4
          }
        },
        {
          "id": "mux3",
          "type": "plexers.mux",
          "pos": [
            0,
            0
          ],
          "attrs": {
            "bitsize": 32
          }
        },
        {
          "id": "mux4",
          "type": "plexers.mux",
          "pos": [
            0,
            0
          ],
          "attrs": {
            "bitsize": 32,
            "selectBits": 2
          }
        },
        {
          "id": "bit-extender0",
          "type": "arith.bit-extender",
          "pos": [
            0,
            0
          ],
          "attrs": {
            "inBits": 17,
            "outBits": 32,
            "mode": "sign"
          }
        },
        {
          "id": "constant2",
          "type": "wiring.constant",
          "pos": [
            0,
            0
          ],
          "attrs": {
            "value": "1",
            "bitsize": 32
          }
        },
        {
          "id": "constant3",
          "type": "wiring.constant",
          "pos": [
            0,
            0
          ],
          "attrs": {
            "value": "0",
            "bitsize": 32
          }
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
          "id": "mux5",
          "type": "plexers.mux",
          "pos": [
            0,
            0
          ],
          "attrs": {
            "bitsize": 32
          }
        },
        {
          "id": "xor0",
          "type": "gate.xor",
          "pos": [
            0,
            0
          ],
          "attrs": {
            "bitsize": 32
          }
        },
        {
          "id": "splitter3",
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
        },
        {
          "id": "decoder1",
          "type": "plexers.decoder",
          "pos": [
            0,
            0
          ],
          "attrs": {
            "inputBits": 4
          }
        },
        {
          "id": "decoder2",
          "type": "plexers.decoder",
          "pos": [
            0,
            0
          ],
          "attrs": {
            "inputBits": 3
          }
        },
        {
          "id": "rom1",
          "type": "mem.rom",
          "pos": [
            0,
            0
          ],
          "attrs": {
            "bitsize": 4,
            "depth": 8,
            "contents": "2 2 3 4 4 9 a 0"
          }
        },
        {
          "id": "mux6",
          "type": "plexers.mux",
          "pos": [
            0,
            0
          ],
          "attrs": {
            "bitsize": 4,
            "selectBits": 4
          }
        },
        {
          "id": "constant4",
          "type": "wiring.constant",
          "pos": [
            0,
            0
          ],
          "attrs": {
            "value": "1",
            "bitsize": 4
          }
        },
        {
          "id": "constant5",
          "type": "wiring.constant",
          "pos": [
            0,
            0
          ],
          "attrs": {
            "value": "0",
            "bitsize": 4
          }
        },
        {
          "id": "constant6",
          "type": "wiring.constant",
          "pos": [
            0,
            0
          ],
          "attrs": {
            "value": "5",
            "bitsize": 4
          }
        },
        {
          "id": "constant7",
          "type": "wiring.constant",
          "pos": [
            0,
            0
          ],
          "attrs": {
            "value": "a",
            "bitsize": 4
          }
        },
        {
          "id": "constant8",
          "type": "wiring.constant",
          "pos": [
            0,
            0
          ],
          "attrs": {
            "value": "8",
            "bitsize": 4
          }
        },
        {
          "id": "mux7",
          "type": "plexers.mux",
          "pos": [
            0,
            0
          ],
          "attrs": {
            "bitsize": 4
          }
        },
        {
          "id": "constant9",
          "type": "wiring.constant",
          "pos": [
            0,
            0
          ],
          "attrs": {
            "value": "7",
            "bitsize": 4
          }
        },
        {
          "id": "constant10",
          "type": "wiring.constant",
          "pos": [
            0,
            0
          ],
          "attrs": {
            "value": "6",
            "bitsize": 4
          }
        },
        {
          "id": "buffer0",
          "type": "gate.buffer",
          "pos": [
            0,
            0
          ]
        },
        {
          "id": "and0",
          "type": "gate.and",
          "pos": [
            0,
            0
          ]
        },
        {
          "id": "or0",
          "type": "gate.or",
          "pos": [
            0,
            0
          ]
        },
        {
          "id": "buffer1",
          "type": "gate.buffer",
          "pos": [
            0,
            0
          ]
        },
        {
          "id": "or1",
          "type": "gate.or",
          "pos": [
            0,
            0
          ],
          "attrs": {
            "inputs": 3
          }
        },
        {
          "id": "or2",
          "type": "gate.or",
          "pos": [
            0,
            0
          ]
        },
        {
          "id": "constant11",
          "type": "wiring.constant",
          "pos": [
            0,
            0
          ],
          "attrs": {
            "value": "0",
            "bitsize": 32
          }
        },
        {
          "id": "and1",
          "type": "gate.and",
          "pos": [
            0,
            0
          ]
        },
        {
          "id": "and2",
          "type": "gate.and",
          "pos": [
            0,
            0
          ]
        },
        {
          "id": "and3",
          "type": "gate.and",
          "pos": [
            0,
            0
          ]
        },
        {
          "id": "and4",
          "type": "gate.and",
          "pos": [
            0,
            0
          ]
        },
        {
          "id": "and5",
          "type": "gate.and",
          "pos": [
            0,
            0
          ]
        },
        {
          "id": "and6",
          "type": "gate.and",
          "pos": [
            0,
            0
          ]
        },
        {
          "id": "and7",
          "type": "gate.and",
          "pos": [
            0,
            0
          ]
        },
        {
          "id": "and8",
          "type": "gate.and",
          "pos": [
            0,
            0
          ]
        },
        {
          "id": "and9",
          "type": "gate.and",
          "pos": [
            0,
            0
          ]
        },
        {
          "id": "and10",
          "type": "gate.and",
          "pos": [
            0,
            0
          ]
        },
        {
          "id": "and11",
          "type": "gate.and",
          "pos": [
            0,
            0
          ]
        },
        {
          "id": "and12",
          "type": "gate.and",
          "pos": [
            0,
            0
          ]
        },
        {
          "id": "and13",
          "type": "gate.and",
          "pos": [
            0,
            0
          ]
        },
        {
          "id": "and14",
          "type": "gate.and",
          "pos": [
            0,
            0
          ]
        },
        {
          "id": "and15",
          "type": "gate.and",
          "pos": [
            0,
            0
          ]
        },
        {
          "id": "buffer2",
          "type": "gate.buffer",
          "pos": [
            0,
            0
          ]
        },
        {
          "id": "buffer3",
          "type": "gate.buffer",
          "pos": [
            0,
            0
          ]
        },
        {
          "id": "buffer4",
          "type": "gate.buffer",
          "pos": [
            0,
            0
          ]
        },
        {
          "id": "or3",
          "type": "gate.or",
          "pos": [
            0,
            0
          ]
        },
        {
          "id": "or4",
          "type": "gate.or",
          "pos": [
            0,
            0
          ],
          "attrs": {
            "inputs": 3
          }
        },
        {
          "id": "buffer5",
          "type": "gate.buffer",
          "pos": [
            0,
            0
          ]
        },
        {
          "id": "splitter4",
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
              ]
            }
          }
        },
        {
          "id": "buffer6",
          "type": "gate.buffer",
          "pos": [
            0,
            0
          ]
        },
        {
          "id": "p_alu",
          "type": "wiring.probe",
          "pos": [
            0,
            0
          ],
          "name": "p_alu",
          "attrs": {
            "bitsize": 32
          }
        },
        {
          "id": "p_ns",
          "type": "wiring.probe",
          "pos": [
            0,
            0
          ],
          "name": "p_ns",
          "attrs": {
            "bitsize": 4
          }
        },
        {
          "id": "p_imem",
          "type": "wiring.probe",
          "pos": [
            0,
            0
          ],
          "name": "p_imem",
          "attrs": {
            "bitsize": 32
          }
        },
        {
          "id": "p_eq",
          "type": "wiring.probe",
          "pos": [
            0,
            0
          ],
          "name": "p_eq"
        },
        {
          "id": "p_pcwe",
          "type": "wiring.probe",
          "pos": [
            0,
            0
          ],
          "name": "p_pcwe"
        },
        {
          "id": "p_irwe",
          "type": "wiring.probe",
          "pos": [
            0,
            0
          ],
          "name": "p_irwe"
        },
        {
          "id": "sum",
          "type": "wiring.probe",
          "pos": [
            0,
            0
          ],
          "name": "sum",
          "attrs": {
            "bitsize": 32
          }
        },
        {
          "id": "pc_out",
          "type": "wiring.probe",
          "pos": [
            0,
            0
          ],
          "name": "pc_out",
          "attrs": {
            "bitsize": 32
          }
        }
      ],
      "wires": [
        {
          "a": {
            "comp": "clk",
            "pin": "out"
          },
          "b": {
            "comp": "register0",
            "pin": "clk"
          }
        },
        {
          "a": {
            "comp": "clk",
            "pin": "out"
          },
          "b": {
            "comp": "register1",
            "pin": "clk"
          }
        },
        {
          "a": {
            "comp": "clk",
            "pin": "out"
          },
          "b": {
            "comp": "register2",
            "pin": "clk"
          }
        },
        {
          "a": {
            "comp": "clk",
            "pin": "out"
          },
          "b": {
            "comp": "register3",
            "pin": "clk"
          }
        },
        {
          "a": {
            "comp": "clk",
            "pin": "out"
          },
          "b": {
            "comp": "register4",
            "pin": "clk"
          }
        },
        {
          "a": {
            "comp": "clk",
            "pin": "out"
          },
          "b": {
            "comp": "register5",
            "pin": "clk"
          }
        },
        {
          "a": {
            "comp": "clk",
            "pin": "out"
          },
          "b": {
            "comp": "register6",
            "pin": "clk"
          }
        },
        {
          "a": {
            "comp": "constant0",
            "pin": "out"
          },
          "b": {
            "comp": "register6",
            "pin": "en"
          }
        },
        {
          "a": {
            "comp": "register0",
            "pin": "q"
          },
          "b": {
            "comp": "splitter0",
            "pin": "bus"
          }
        },
        {
          "a": {
            "comp": "splitter0",
            "pin": "lo"
          },
          "b": {
            "comp": "rom0",
            "pin": "addr"
          }
        },
        {
          "a": {
            "comp": "rom0",
            "pin": "out"
          },
          "b": {
            "comp": "register1",
            "pin": "d"
          }
        },
        {
          "a": {
            "comp": "register4",
            "pin": "q"
          },
          "b": {
            "comp": "splitter1",
            "pin": "bus"
          }
        },
        {
          "a": {
            "comp": "splitter1",
            "pin": "lo"
          },
          "b": {
            "comp": "ram0",
            "pin": "addr"
          }
        },
        {
          "a": {
            "comp": "clk",
            "pin": "out"
          },
          "b": {
            "comp": "ram0",
            "pin": "clk"
          }
        },
        {
          "a": {
            "comp": "ram0",
            "pin": "dout"
          },
          "b": {
            "comp": "register5",
            "pin": "d"
          }
        },
        {
          "a": {
            "comp": "register1",
            "pin": "q"
          },
          "b": {
            "comp": "splitter2",
            "pin": "bus"
          }
        },
        {
          "a": {
            "comp": "clk",
            "pin": "out"
          },
          "b": {
            "comp": "register7",
            "pin": "clk"
          }
        },
        {
          "a": {
            "comp": "clk",
            "pin": "out"
          },
          "b": {
            "comp": "register8",
            "pin": "clk"
          }
        },
        {
          "a": {
            "comp": "clk",
            "pin": "out"
          },
          "b": {
            "comp": "register9",
            "pin": "clk"
          }
        },
        {
          "a": {
            "comp": "clk",
            "pin": "out"
          },
          "b": {
            "comp": "register10",
            "pin": "clk"
          }
        },
        {
          "a": {
            "comp": "clk",
            "pin": "out"
          },
          "b": {
            "comp": "register11",
            "pin": "clk"
          }
        },
        {
          "a": {
            "comp": "clk",
            "pin": "out"
          },
          "b": {
            "comp": "register12",
            "pin": "clk"
          }
        },
        {
          "a": {
            "comp": "clk",
            "pin": "out"
          },
          "b": {
            "comp": "register13",
            "pin": "clk"
          }
        },
        {
          "a": {
            "comp": "clk",
            "pin": "out"
          },
          "b": {
            "comp": "register14",
            "pin": "clk"
          }
        },
        {
          "a": {
            "comp": "clk",
            "pin": "out"
          },
          "b": {
            "comp": "register15",
            "pin": "clk"
          }
        },
        {
          "a": {
            "comp": "clk",
            "pin": "out"
          },
          "b": {
            "comp": "register16",
            "pin": "clk"
          }
        },
        {
          "a": {
            "comp": "clk",
            "pin": "out"
          },
          "b": {
            "comp": "register17",
            "pin": "clk"
          }
        },
        {
          "a": {
            "comp": "clk",
            "pin": "out"
          },
          "b": {
            "comp": "register18",
            "pin": "clk"
          }
        },
        {
          "a": {
            "comp": "clk",
            "pin": "out"
          },
          "b": {
            "comp": "register19",
            "pin": "clk"
          }
        },
        {
          "a": {
            "comp": "clk",
            "pin": "out"
          },
          "b": {
            "comp": "register20",
            "pin": "clk"
          }
        },
        {
          "a": {
            "comp": "clk",
            "pin": "out"
          },
          "b": {
            "comp": "register21",
            "pin": "clk"
          }
        },
        {
          "a": {
            "comp": "clk",
            "pin": "out"
          },
          "b": {
            "comp": "register22",
            "pin": "clk"
          }
        },
        {
          "a": {
            "comp": "register7",
            "pin": "q"
          },
          "b": {
            "comp": "mux0",
            "pin": "in0"
          }
        },
        {
          "a": {
            "comp": "register8",
            "pin": "q"
          },
          "b": {
            "comp": "mux0",
            "pin": "in1"
          }
        },
        {
          "a": {
            "comp": "register9",
            "pin": "q"
          },
          "b": {
            "comp": "mux0",
            "pin": "in2"
          }
        },
        {
          "a": {
            "comp": "register10",
            "pin": "q"
          },
          "b": {
            "comp": "mux0",
            "pin": "in3"
          }
        },
        {
          "a": {
            "comp": "register11",
            "pin": "q"
          },
          "b": {
            "comp": "mux0",
            "pin": "in4"
          }
        },
        {
          "a": {
            "comp": "register12",
            "pin": "q"
          },
          "b": {
            "comp": "mux0",
            "pin": "in5"
          }
        },
        {
          "a": {
            "comp": "register13",
            "pin": "q"
          },
          "b": {
            "comp": "mux0",
            "pin": "in6"
          }
        },
        {
          "a": {
            "comp": "register14",
            "pin": "q"
          },
          "b": {
            "comp": "mux0",
            "pin": "in7"
          }
        },
        {
          "a": {
            "comp": "register15",
            "pin": "q"
          },
          "b": {
            "comp": "mux0",
            "pin": "in8"
          }
        },
        {
          "a": {
            "comp": "register16",
            "pin": "q"
          },
          "b": {
            "comp": "mux0",
            "pin": "in9"
          }
        },
        {
          "a": {
            "comp": "register17",
            "pin": "q"
          },
          "b": {
            "comp": "mux0",
            "pin": "in10"
          }
        },
        {
          "a": {
            "comp": "register18",
            "pin": "q"
          },
          "b": {
            "comp": "mux0",
            "pin": "in11"
          }
        },
        {
          "a": {
            "comp": "register19",
            "pin": "q"
          },
          "b": {
            "comp": "mux0",
            "pin": "in12"
          }
        },
        {
          "a": {
            "comp": "register20",
            "pin": "q"
          },
          "b": {
            "comp": "mux0",
            "pin": "in13"
          }
        },
        {
          "a": {
            "comp": "register21",
            "pin": "q"
          },
          "b": {
            "comp": "mux0",
            "pin": "in14"
          }
        },
        {
          "a": {
            "comp": "register22",
            "pin": "q"
          },
          "b": {
            "comp": "mux0",
            "pin": "in15"
          }
        },
        {
          "a": {
            "comp": "splitter2",
            "pin": "rs"
          },
          "b": {
            "comp": "mux0",
            "pin": "sel"
          }
        },
        {
          "a": {
            "comp": "register7",
            "pin": "q"
          },
          "b": {
            "comp": "mux1",
            "pin": "in0"
          }
        },
        {
          "a": {
            "comp": "register8",
            "pin": "q"
          },
          "b": {
            "comp": "mux1",
            "pin": "in1"
          }
        },
        {
          "a": {
            "comp": "register9",
            "pin": "q"
          },
          "b": {
            "comp": "mux1",
            "pin": "in2"
          }
        },
        {
          "a": {
            "comp": "register10",
            "pin": "q"
          },
          "b": {
            "comp": "mux1",
            "pin": "in3"
          }
        },
        {
          "a": {
            "comp": "register11",
            "pin": "q"
          },
          "b": {
            "comp": "mux1",
            "pin": "in4"
          }
        },
        {
          "a": {
            "comp": "register12",
            "pin": "q"
          },
          "b": {
            "comp": "mux1",
            "pin": "in5"
          }
        },
        {
          "a": {
            "comp": "register13",
            "pin": "q"
          },
          "b": {
            "comp": "mux1",
            "pin": "in6"
          }
        },
        {
          "a": {
            "comp": "register14",
            "pin": "q"
          },
          "b": {
            "comp": "mux1",
            "pin": "in7"
          }
        },
        {
          "a": {
            "comp": "register15",
            "pin": "q"
          },
          "b": {
            "comp": "mux1",
            "pin": "in8"
          }
        },
        {
          "a": {
            "comp": "register16",
            "pin": "q"
          },
          "b": {
            "comp": "mux1",
            "pin": "in9"
          }
        },
        {
          "a": {
            "comp": "register17",
            "pin": "q"
          },
          "b": {
            "comp": "mux1",
            "pin": "in10"
          }
        },
        {
          "a": {
            "comp": "register18",
            "pin": "q"
          },
          "b": {
            "comp": "mux1",
            "pin": "in11"
          }
        },
        {
          "a": {
            "comp": "register19",
            "pin": "q"
          },
          "b": {
            "comp": "mux1",
            "pin": "in12"
          }
        },
        {
          "a": {
            "comp": "register20",
            "pin": "q"
          },
          "b": {
            "comp": "mux1",
            "pin": "in13"
          }
        },
        {
          "a": {
            "comp": "register21",
            "pin": "q"
          },
          "b": {
            "comp": "mux1",
            "pin": "in14"
          }
        },
        {
          "a": {
            "comp": "register22",
            "pin": "q"
          },
          "b": {
            "comp": "mux1",
            "pin": "in15"
          }
        },
        {
          "a": {
            "comp": "splitter2",
            "pin": "rt"
          },
          "b": {
            "comp": "mux1",
            "pin": "sel"
          }
        },
        {
          "a": {
            "comp": "mux0",
            "pin": "out"
          },
          "b": {
            "comp": "register2",
            "pin": "d"
          }
        },
        {
          "a": {
            "comp": "mux1",
            "pin": "out"
          },
          "b": {
            "comp": "register3",
            "pin": "d"
          }
        },
        {
          "a": {
            "comp": "register4",
            "pin": "q"
          },
          "b": {
            "comp": "mux2",
            "pin": "in0"
          }
        },
        {
          "a": {
            "comp": "register5",
            "pin": "q"
          },
          "b": {
            "comp": "mux2",
            "pin": "in1"
          }
        },
        {
          "a": {
            "comp": "splitter2",
            "pin": "rd"
          },
          "b": {
            "comp": "decoder0",
            "pin": "in"
          }
        },
        {
          "a": {
            "comp": "register2",
            "pin": "q"
          },
          "b": {
            "comp": "mux3",
            "pin": "in0"
          }
        },
        {
          "a": {
            "comp": "register0",
            "pin": "q"
          },
          "b": {
            "comp": "mux3",
            "pin": "in1"
          }
        },
        {
          "a": {
            "comp": "register3",
            "pin": "q"
          },
          "b": {
            "comp": "mux4",
            "pin": "in0"
          }
        },
        {
          "a": {
            "comp": "splitter2",
            "pin": "imm"
          },
          "b": {
            "comp": "bit-extender0",
            "pin": "in"
          }
        },
        {
          "a": {
            "comp": "bit-extender0",
            "pin": "out"
          },
          "b": {
            "comp": "mux4",
            "pin": "in1"
          }
        },
        {
          "a": {
            "comp": "constant2",
            "pin": "out"
          },
          "b": {
            "comp": "mux4",
            "pin": "in2"
          }
        },
        {
          "a": {
            "comp": "constant3",
            "pin": "out"
          },
          "b": {
            "comp": "mux4",
            "pin": "in3"
          }
        },
        {
          "a": {
            "comp": "mux3",
            "pin": "out"
          },
          "b": {
            "comp": "adder0",
            "pin": "a"
          }
        },
        {
          "a": {
            "comp": "mux4",
            "pin": "out"
          },
          "b": {
            "comp": "adder0",
            "pin": "b"
          }
        },
        {
          "a": {
            "comp": "constant1",
            "pin": "out"
          },
          "b": {
            "comp": "adder0",
            "pin": "cin"
          }
        },
        {
          "a": {
            "comp": "mux3",
            "pin": "out"
          },
          "b": {
            "comp": "nand0",
            "pin": "in0"
          }
        },
        {
          "a": {
            "comp": "mux4",
            "pin": "out"
          },
          "b": {
            "comp": "nand0",
            "pin": "in1"
          }
        },
        {
          "a": {
            "comp": "adder0",
            "pin": "out"
          },
          "b": {
            "comp": "mux5",
            "pin": "in0"
          }
        },
        {
          "a": {
            "comp": "nand0",
            "pin": "out"
          },
          "b": {
            "comp": "mux5",
            "pin": "in1"
          }
        },
        {
          "a": {
            "comp": "mux5",
            "pin": "out"
          },
          "b": {
            "comp": "register4",
            "pin": "d"
          }
        },
        {
          "a": {
            "comp": "mux5",
            "pin": "out"
          },
          "b": {
            "comp": "register0",
            "pin": "d"
          }
        },
        {
          "a": {
            "comp": "register2",
            "pin": "q"
          },
          "b": {
            "comp": "xor0",
            "pin": "in0"
          }
        },
        {
          "a": {
            "comp": "register3",
            "pin": "q"
          },
          "b": {
            "comp": "xor0",
            "pin": "in1"
          }
        },
        {
          "a": {
            "comp": "xor0",
            "pin": "out"
          },
          "b": {
            "comp": "splitter3",
            "pin": "bus"
          }
        },
        {
          "a": {
            "comp": "splitter3",
            "pin": "b0"
          },
          "b": {
            "comp": "nor0",
            "pin": "in0"
          }
        },
        {
          "a": {
            "comp": "splitter3",
            "pin": "b1"
          },
          "b": {
            "comp": "nor0",
            "pin": "in1"
          }
        },
        {
          "a": {
            "comp": "splitter3",
            "pin": "b2"
          },
          "b": {
            "comp": "nor0",
            "pin": "in2"
          }
        },
        {
          "a": {
            "comp": "splitter3",
            "pin": "b3"
          },
          "b": {
            "comp": "nor0",
            "pin": "in3"
          }
        },
        {
          "a": {
            "comp": "splitter3",
            "pin": "b4"
          },
          "b": {
            "comp": "nor0",
            "pin": "in4"
          }
        },
        {
          "a": {
            "comp": "splitter3",
            "pin": "b5"
          },
          "b": {
            "comp": "nor0",
            "pin": "in5"
          }
        },
        {
          "a": {
            "comp": "splitter3",
            "pin": "b6"
          },
          "b": {
            "comp": "nor0",
            "pin": "in6"
          }
        },
        {
          "a": {
            "comp": "splitter3",
            "pin": "b7"
          },
          "b": {
            "comp": "nor0",
            "pin": "in7"
          }
        },
        {
          "a": {
            "comp": "splitter3",
            "pin": "b8"
          },
          "b": {
            "comp": "nor0",
            "pin": "in8"
          }
        },
        {
          "a": {
            "comp": "splitter3",
            "pin": "b9"
          },
          "b": {
            "comp": "nor0",
            "pin": "in9"
          }
        },
        {
          "a": {
            "comp": "splitter3",
            "pin": "b10"
          },
          "b": {
            "comp": "nor0",
            "pin": "in10"
          }
        },
        {
          "a": {
            "comp": "splitter3",
            "pin": "b11"
          },
          "b": {
            "comp": "nor0",
            "pin": "in11"
          }
        },
        {
          "a": {
            "comp": "splitter3",
            "pin": "b12"
          },
          "b": {
            "comp": "nor0",
            "pin": "in12"
          }
        },
        {
          "a": {
            "comp": "splitter3",
            "pin": "b13"
          },
          "b": {
            "comp": "nor0",
            "pin": "in13"
          }
        },
        {
          "a": {
            "comp": "splitter3",
            "pin": "b14"
          },
          "b": {
            "comp": "nor0",
            "pin": "in14"
          }
        },
        {
          "a": {
            "comp": "splitter3",
            "pin": "b15"
          },
          "b": {
            "comp": "nor0",
            "pin": "in15"
          }
        },
        {
          "a": {
            "comp": "splitter3",
            "pin": "b16"
          },
          "b": {
            "comp": "nor0",
            "pin": "in16"
          }
        },
        {
          "a": {
            "comp": "splitter3",
            "pin": "b17"
          },
          "b": {
            "comp": "nor0",
            "pin": "in17"
          }
        },
        {
          "a": {
            "comp": "splitter3",
            "pin": "b18"
          },
          "b": {
            "comp": "nor0",
            "pin": "in18"
          }
        },
        {
          "a": {
            "comp": "splitter3",
            "pin": "b19"
          },
          "b": {
            "comp": "nor0",
            "pin": "in19"
          }
        },
        {
          "a": {
            "comp": "splitter3",
            "pin": "b20"
          },
          "b": {
            "comp": "nor0",
            "pin": "in20"
          }
        },
        {
          "a": {
            "comp": "splitter3",
            "pin": "b21"
          },
          "b": {
            "comp": "nor0",
            "pin": "in21"
          }
        },
        {
          "a": {
            "comp": "splitter3",
            "pin": "b22"
          },
          "b": {
            "comp": "nor0",
            "pin": "in22"
          }
        },
        {
          "a": {
            "comp": "splitter3",
            "pin": "b23"
          },
          "b": {
            "comp": "nor0",
            "pin": "in23"
          }
        },
        {
          "a": {
            "comp": "splitter3",
            "pin": "b24"
          },
          "b": {
            "comp": "nor0",
            "pin": "in24"
          }
        },
        {
          "a": {
            "comp": "splitter3",
            "pin": "b25"
          },
          "b": {
            "comp": "nor0",
            "pin": "in25"
          }
        },
        {
          "a": {
            "comp": "splitter3",
            "pin": "b26"
          },
          "b": {
            "comp": "nor0",
            "pin": "in26"
          }
        },
        {
          "a": {
            "comp": "splitter3",
            "pin": "b27"
          },
          "b": {
            "comp": "nor0",
            "pin": "in27"
          }
        },
        {
          "a": {
            "comp": "splitter3",
            "pin": "b28"
          },
          "b": {
            "comp": "nor0",
            "pin": "in28"
          }
        },
        {
          "a": {
            "comp": "splitter3",
            "pin": "b29"
          },
          "b": {
            "comp": "nor0",
            "pin": "in29"
          }
        },
        {
          "a": {
            "comp": "splitter3",
            "pin": "b30"
          },
          "b": {
            "comp": "nor0",
            "pin": "in30"
          }
        },
        {
          "a": {
            "comp": "splitter3",
            "pin": "b31"
          },
          "b": {
            "comp": "nor0",
            "pin": "in31"
          }
        },
        {
          "a": {
            "comp": "register6",
            "pin": "q"
          },
          "b": {
            "comp": "decoder1",
            "pin": "in"
          }
        },
        {
          "a": {
            "comp": "splitter2",
            "pin": "op"
          },
          "b": {
            "comp": "decoder2",
            "pin": "in"
          }
        },
        {
          "a": {
            "comp": "splitter2",
            "pin": "op"
          },
          "b": {
            "comp": "rom1",
            "pin": "addr"
          }
        },
        {
          "a": {
            "comp": "constant9",
            "pin": "out"
          },
          "b": {
            "comp": "mux7",
            "pin": "in0"
          }
        },
        {
          "a": {
            "comp": "constant10",
            "pin": "out"
          },
          "b": {
            "comp": "mux7",
            "pin": "in1"
          }
        },
        {
          "a": {
            "comp": "decoder2",
            "pin": "out3"
          },
          "b": {
            "comp": "mux7",
            "pin": "sel"
          }
        },
        {
          "a": {
            "comp": "constant4",
            "pin": "out"
          },
          "b": {
            "comp": "mux6",
            "pin": "in0"
          }
        },
        {
          "a": {
            "comp": "rom1",
            "pin": "out"
          },
          "b": {
            "comp": "mux6",
            "pin": "in1"
          }
        },
        {
          "a": {
            "comp": "constant6",
            "pin": "out"
          },
          "b": {
            "comp": "mux6",
            "pin": "in2"
          }
        },
        {
          "a": {
            "comp": "constant6",
            "pin": "out"
          },
          "b": {
            "comp": "mux6",
            "pin": "in3"
          }
        },
        {
          "a": {
            "comp": "mux7",
            "pin": "out"
          },
          "b": {
            "comp": "mux6",
            "pin": "in4"
          }
        },
        {
          "a": {
            "comp": "constant5",
            "pin": "out"
          },
          "b": {
            "comp": "mux6",
            "pin": "in5"
          }
        },
        {
          "a": {
            "comp": "constant8",
            "pin": "out"
          },
          "b": {
            "comp": "mux6",
            "pin": "in6"
          }
        },
        {
          "a": {
            "comp": "constant5",
            "pin": "out"
          },
          "b": {
            "comp": "mux6",
            "pin": "in7"
          }
        },
        {
          "a": {
            "comp": "constant5",
            "pin": "out"
          },
          "b": {
            "comp": "mux6",
            "pin": "in8"
          }
        },
        {
          "a": {
            "comp": "constant5",
            "pin": "out"
          },
          "b": {
            "comp": "mux6",
            "pin": "in9"
          }
        },
        {
          "a": {
            "comp": "constant7",
            "pin": "out"
          },
          "b": {
            "comp": "mux6",
            "pin": "in10"
          }
        },
        {
          "a": {
            "comp": "constant5",
            "pin": "out"
          },
          "b": {
            "comp": "mux6",
            "pin": "in11"
          }
        },
        {
          "a": {
            "comp": "constant5",
            "pin": "out"
          },
          "b": {
            "comp": "mux6",
            "pin": "in12"
          }
        },
        {
          "a": {
            "comp": "constant5",
            "pin": "out"
          },
          "b": {
            "comp": "mux6",
            "pin": "in13"
          }
        },
        {
          "a": {
            "comp": "constant5",
            "pin": "out"
          },
          "b": {
            "comp": "mux6",
            "pin": "in14"
          }
        },
        {
          "a": {
            "comp": "constant5",
            "pin": "out"
          },
          "b": {
            "comp": "mux6",
            "pin": "in15"
          }
        },
        {
          "a": {
            "comp": "register6",
            "pin": "q"
          },
          "b": {
            "comp": "mux6",
            "pin": "sel"
          }
        },
        {
          "a": {
            "comp": "mux6",
            "pin": "out"
          },
          "b": {
            "comp": "register6",
            "pin": "d"
          }
        },
        {
          "a": {
            "comp": "decoder1",
            "pin": "out0"
          },
          "b": {
            "comp": "buffer0",
            "pin": "in"
          }
        },
        {
          "a": {
            "comp": "buffer0",
            "pin": "out"
          },
          "b": {
            "comp": "register1",
            "pin": "en"
          }
        },
        {
          "a": {
            "comp": "decoder1",
            "pin": "out9"
          },
          "b": {
            "comp": "and0",
            "pin": "in0"
          }
        },
        {
          "a": {
            "comp": "nor0",
            "pin": "out"
          },
          "b": {
            "comp": "and0",
            "pin": "in1"
          }
        },
        {
          "a": {
            "comp": "decoder1",
            "pin": "out0"
          },
          "b": {
            "comp": "or0",
            "pin": "in0"
          }
        },
        {
          "a": {
            "comp": "and0",
            "pin": "out"
          },
          "b": {
            "comp": "or0",
            "pin": "in1"
          }
        },
        {
          "a": {
            "comp": "or0",
            "pin": "out"
          },
          "b": {
            "comp": "register0",
            "pin": "en"
          }
        },
        {
          "a": {
            "comp": "decoder1",
            "pin": "out1"
          },
          "b": {
            "comp": "buffer1",
            "pin": "in"
          }
        },
        {
          "a": {
            "comp": "buffer1",
            "pin": "out"
          },
          "b": {
            "comp": "register2",
            "pin": "en"
          }
        },
        {
          "a": {
            "comp": "buffer1",
            "pin": "out"
          },
          "b": {
            "comp": "register3",
            "pin": "en"
          }
        },
        {
          "a": {
            "comp": "decoder1",
            "pin": "out2"
          },
          "b": {
            "comp": "or1",
            "pin": "in0"
          }
        },
        {
          "a": {
            "comp": "decoder1",
            "pin": "out3"
          },
          "b": {
            "comp": "or1",
            "pin": "in1"
          }
        },
        {
          "a": {
            "comp": "decoder1",
            "pin": "out4"
          },
          "b": {
            "comp": "or1",
            "pin": "in2"
          }
        },
        {
          "a": {
            "comp": "or1",
            "pin": "out"
          },
          "b": {
            "comp": "register4",
            "pin": "en"
          }
        },
        {
          "a": {
            "comp": "decoder1",
            "pin": "out5"
          },
          "b": {
            "comp": "or2",
            "pin": "in0"
          }
        },
        {
          "a": {
            "comp": "decoder1",
            "pin": "out8"
          },
          "b": {
            "comp": "or2",
            "pin": "in1"
          }
        },
        {
          "a": {
            "comp": "constant1",
            "pin": "out"
          },
          "b": {
            "comp": "register7",
            "pin": "en"
          }
        },
        {
          "a": {
            "comp": "constant11",
            "pin": "out"
          },
          "b": {
            "comp": "register7",
            "pin": "d"
          }
        },
        {
          "a": {
            "comp": "decoder0",
            "pin": "out1"
          },
          "b": {
            "comp": "and1",
            "pin": "in0"
          }
        },
        {
          "a": {
            "comp": "or2",
            "pin": "out"
          },
          "b": {
            "comp": "and1",
            "pin": "in1"
          }
        },
        {
          "a": {
            "comp": "and1",
            "pin": "out"
          },
          "b": {
            "comp": "register8",
            "pin": "en"
          }
        },
        {
          "a": {
            "comp": "mux2",
            "pin": "out"
          },
          "b": {
            "comp": "register8",
            "pin": "d"
          }
        },
        {
          "a": {
            "comp": "decoder0",
            "pin": "out2"
          },
          "b": {
            "comp": "and2",
            "pin": "in0"
          }
        },
        {
          "a": {
            "comp": "or2",
            "pin": "out"
          },
          "b": {
            "comp": "and2",
            "pin": "in1"
          }
        },
        {
          "a": {
            "comp": "and2",
            "pin": "out"
          },
          "b": {
            "comp": "register9",
            "pin": "en"
          }
        },
        {
          "a": {
            "comp": "mux2",
            "pin": "out"
          },
          "b": {
            "comp": "register9",
            "pin": "d"
          }
        },
        {
          "a": {
            "comp": "decoder0",
            "pin": "out3"
          },
          "b": {
            "comp": "and3",
            "pin": "in0"
          }
        },
        {
          "a": {
            "comp": "or2",
            "pin": "out"
          },
          "b": {
            "comp": "and3",
            "pin": "in1"
          }
        },
        {
          "a": {
            "comp": "and3",
            "pin": "out"
          },
          "b": {
            "comp": "register10",
            "pin": "en"
          }
        },
        {
          "a": {
            "comp": "mux2",
            "pin": "out"
          },
          "b": {
            "comp": "register10",
            "pin": "d"
          }
        },
        {
          "a": {
            "comp": "decoder0",
            "pin": "out4"
          },
          "b": {
            "comp": "and4",
            "pin": "in0"
          }
        },
        {
          "a": {
            "comp": "or2",
            "pin": "out"
          },
          "b": {
            "comp": "and4",
            "pin": "in1"
          }
        },
        {
          "a": {
            "comp": "and4",
            "pin": "out"
          },
          "b": {
            "comp": "register11",
            "pin": "en"
          }
        },
        {
          "a": {
            "comp": "mux2",
            "pin": "out"
          },
          "b": {
            "comp": "register11",
            "pin": "d"
          }
        },
        {
          "a": {
            "comp": "decoder0",
            "pin": "out5"
          },
          "b": {
            "comp": "and5",
            "pin": "in0"
          }
        },
        {
          "a": {
            "comp": "or2",
            "pin": "out"
          },
          "b": {
            "comp": "and5",
            "pin": "in1"
          }
        },
        {
          "a": {
            "comp": "and5",
            "pin": "out"
          },
          "b": {
            "comp": "register12",
            "pin": "en"
          }
        },
        {
          "a": {
            "comp": "mux2",
            "pin": "out"
          },
          "b": {
            "comp": "register12",
            "pin": "d"
          }
        },
        {
          "a": {
            "comp": "decoder0",
            "pin": "out6"
          },
          "b": {
            "comp": "and6",
            "pin": "in0"
          }
        },
        {
          "a": {
            "comp": "or2",
            "pin": "out"
          },
          "b": {
            "comp": "and6",
            "pin": "in1"
          }
        },
        {
          "a": {
            "comp": "and6",
            "pin": "out"
          },
          "b": {
            "comp": "register13",
            "pin": "en"
          }
        },
        {
          "a": {
            "comp": "mux2",
            "pin": "out"
          },
          "b": {
            "comp": "register13",
            "pin": "d"
          }
        },
        {
          "a": {
            "comp": "decoder0",
            "pin": "out7"
          },
          "b": {
            "comp": "and7",
            "pin": "in0"
          }
        },
        {
          "a": {
            "comp": "or2",
            "pin": "out"
          },
          "b": {
            "comp": "and7",
            "pin": "in1"
          }
        },
        {
          "a": {
            "comp": "and7",
            "pin": "out"
          },
          "b": {
            "comp": "register14",
            "pin": "en"
          }
        },
        {
          "a": {
            "comp": "mux2",
            "pin": "out"
          },
          "b": {
            "comp": "register14",
            "pin": "d"
          }
        },
        {
          "a": {
            "comp": "decoder0",
            "pin": "out8"
          },
          "b": {
            "comp": "and8",
            "pin": "in0"
          }
        },
        {
          "a": {
            "comp": "or2",
            "pin": "out"
          },
          "b": {
            "comp": "and8",
            "pin": "in1"
          }
        },
        {
          "a": {
            "comp": "and8",
            "pin": "out"
          },
          "b": {
            "comp": "register15",
            "pin": "en"
          }
        },
        {
          "a": {
            "comp": "mux2",
            "pin": "out"
          },
          "b": {
            "comp": "register15",
            "pin": "d"
          }
        },
        {
          "a": {
            "comp": "decoder0",
            "pin": "out9"
          },
          "b": {
            "comp": "and9",
            "pin": "in0"
          }
        },
        {
          "a": {
            "comp": "or2",
            "pin": "out"
          },
          "b": {
            "comp": "and9",
            "pin": "in1"
          }
        },
        {
          "a": {
            "comp": "and9",
            "pin": "out"
          },
          "b": {
            "comp": "register16",
            "pin": "en"
          }
        },
        {
          "a": {
            "comp": "mux2",
            "pin": "out"
          },
          "b": {
            "comp": "register16",
            "pin": "d"
          }
        },
        {
          "a": {
            "comp": "decoder0",
            "pin": "out10"
          },
          "b": {
            "comp": "and10",
            "pin": "in0"
          }
        },
        {
          "a": {
            "comp": "or2",
            "pin": "out"
          },
          "b": {
            "comp": "and10",
            "pin": "in1"
          }
        },
        {
          "a": {
            "comp": "and10",
            "pin": "out"
          },
          "b": {
            "comp": "register17",
            "pin": "en"
          }
        },
        {
          "a": {
            "comp": "mux2",
            "pin": "out"
          },
          "b": {
            "comp": "register17",
            "pin": "d"
          }
        },
        {
          "a": {
            "comp": "decoder0",
            "pin": "out11"
          },
          "b": {
            "comp": "and11",
            "pin": "in0"
          }
        },
        {
          "a": {
            "comp": "or2",
            "pin": "out"
          },
          "b": {
            "comp": "and11",
            "pin": "in1"
          }
        },
        {
          "a": {
            "comp": "and11",
            "pin": "out"
          },
          "b": {
            "comp": "register18",
            "pin": "en"
          }
        },
        {
          "a": {
            "comp": "mux2",
            "pin": "out"
          },
          "b": {
            "comp": "register18",
            "pin": "d"
          }
        },
        {
          "a": {
            "comp": "decoder0",
            "pin": "out12"
          },
          "b": {
            "comp": "and12",
            "pin": "in0"
          }
        },
        {
          "a": {
            "comp": "or2",
            "pin": "out"
          },
          "b": {
            "comp": "and12",
            "pin": "in1"
          }
        },
        {
          "a": {
            "comp": "and12",
            "pin": "out"
          },
          "b": {
            "comp": "register19",
            "pin": "en"
          }
        },
        {
          "a": {
            "comp": "mux2",
            "pin": "out"
          },
          "b": {
            "comp": "register19",
            "pin": "d"
          }
        },
        {
          "a": {
            "comp": "decoder0",
            "pin": "out13"
          },
          "b": {
            "comp": "and13",
            "pin": "in0"
          }
        },
        {
          "a": {
            "comp": "or2",
            "pin": "out"
          },
          "b": {
            "comp": "and13",
            "pin": "in1"
          }
        },
        {
          "a": {
            "comp": "and13",
            "pin": "out"
          },
          "b": {
            "comp": "register20",
            "pin": "en"
          }
        },
        {
          "a": {
            "comp": "mux2",
            "pin": "out"
          },
          "b": {
            "comp": "register20",
            "pin": "d"
          }
        },
        {
          "a": {
            "comp": "decoder0",
            "pin": "out14"
          },
          "b": {
            "comp": "and14",
            "pin": "in0"
          }
        },
        {
          "a": {
            "comp": "or2",
            "pin": "out"
          },
          "b": {
            "comp": "and14",
            "pin": "in1"
          }
        },
        {
          "a": {
            "comp": "and14",
            "pin": "out"
          },
          "b": {
            "comp": "register21",
            "pin": "en"
          }
        },
        {
          "a": {
            "comp": "mux2",
            "pin": "out"
          },
          "b": {
            "comp": "register21",
            "pin": "d"
          }
        },
        {
          "a": {
            "comp": "decoder0",
            "pin": "out15"
          },
          "b": {
            "comp": "and15",
            "pin": "in0"
          }
        },
        {
          "a": {
            "comp": "or2",
            "pin": "out"
          },
          "b": {
            "comp": "and15",
            "pin": "in1"
          }
        },
        {
          "a": {
            "comp": "and15",
            "pin": "out"
          },
          "b": {
            "comp": "register22",
            "pin": "en"
          }
        },
        {
          "a": {
            "comp": "mux2",
            "pin": "out"
          },
          "b": {
            "comp": "register22",
            "pin": "d"
          }
        },
        {
          "a": {
            "comp": "decoder1",
            "pin": "out8"
          },
          "b": {
            "comp": "buffer2",
            "pin": "in"
          }
        },
        {
          "a": {
            "comp": "buffer2",
            "pin": "out"
          },
          "b": {
            "comp": "mux2",
            "pin": "sel"
          }
        },
        {
          "a": {
            "comp": "decoder1",
            "pin": "out6"
          },
          "b": {
            "comp": "buffer3",
            "pin": "in"
          }
        },
        {
          "a": {
            "comp": "buffer3",
            "pin": "out"
          },
          "b": {
            "comp": "register5",
            "pin": "en"
          }
        },
        {
          "a": {
            "comp": "decoder1",
            "pin": "out7"
          },
          "b": {
            "comp": "buffer4",
            "pin": "in"
          }
        },
        {
          "a": {
            "comp": "buffer4",
            "pin": "out"
          },
          "b": {
            "comp": "ram0",
            "pin": "we"
          }
        },
        {
          "a": {
            "comp": "register3",
            "pin": "q"
          },
          "b": {
            "comp": "ram0",
            "pin": "din"
          }
        },
        {
          "a": {
            "comp": "decoder1",
            "pin": "out0"
          },
          "b": {
            "comp": "or3",
            "pin": "in0"
          }
        },
        {
          "a": {
            "comp": "decoder1",
            "pin": "out9"
          },
          "b": {
            "comp": "or3",
            "pin": "in1"
          }
        },
        {
          "a": {
            "comp": "or3",
            "pin": "out"
          },
          "b": {
            "comp": "mux3",
            "pin": "sel"
          }
        },
        {
          "a": {
            "comp": "decoder1",
            "pin": "out3"
          },
          "b": {
            "comp": "or4",
            "pin": "in0"
          }
        },
        {
          "a": {
            "comp": "decoder1",
            "pin": "out4"
          },
          "b": {
            "comp": "or4",
            "pin": "in1"
          }
        },
        {
          "a": {
            "comp": "decoder1",
            "pin": "out9"
          },
          "b": {
            "comp": "or4",
            "pin": "in2"
          }
        },
        {
          "a": {
            "comp": "decoder1",
            "pin": "out0"
          },
          "b": {
            "comp": "buffer5",
            "pin": "in"
          }
        },
        {
          "a": {
            "comp": "splitter4",
            "pin": "bus"
          },
          "b": {
            "comp": "mux4",
            "pin": "sel"
          }
        },
        {
          "a": {
            "comp": "or4",
            "pin": "out"
          },
          "b": {
            "comp": "splitter4",
            "pin": "b0"
          }
        },
        {
          "a": {
            "comp": "buffer5",
            "pin": "out"
          },
          "b": {
            "comp": "splitter4",
            "pin": "b1"
          }
        },
        {
          "a": {
            "comp": "decoder2",
            "pin": "out1"
          },
          "b": {
            "comp": "buffer6",
            "pin": "in"
          }
        },
        {
          "a": {
            "comp": "buffer6",
            "pin": "out"
          },
          "b": {
            "comp": "mux5",
            "pin": "sel"
          }
        },
        {
          "a": {
            "comp": "mux5",
            "pin": "out"
          },
          "b": {
            "comp": "p_alu",
            "pin": "in"
          }
        },
        {
          "a": {
            "comp": "mux6",
            "pin": "out"
          },
          "b": {
            "comp": "p_ns",
            "pin": "in"
          }
        },
        {
          "a": {
            "comp": "rom0",
            "pin": "out"
          },
          "b": {
            "comp": "p_imem",
            "pin": "in"
          }
        },
        {
          "a": {
            "comp": "nor0",
            "pin": "out"
          },
          "b": {
            "comp": "p_eq",
            "pin": "in"
          }
        },
        {
          "a": {
            "comp": "or0",
            "pin": "out"
          },
          "b": {
            "comp": "p_pcwe",
            "pin": "in"
          }
        },
        {
          "a": {
            "comp": "buffer0",
            "pin": "out"
          },
          "b": {
            "comp": "p_irwe",
            "pin": "in"
          }
        },
        {
          "a": {
            "comp": "register8",
            "pin": "q"
          },
          "b": {
            "comp": "sum",
            "pin": "in"
          }
        },
        {
          "a": {
            "comp": "register0",
            "pin": "q"
          },
          "b": {
            "comp": "pc_out",
            "pin": "in"
          }
        }
      ]
    }
  ]
}

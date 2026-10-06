{
  "format": "circuitsim-plus-plus",
  "version": 2,
  "name": "fsm",
  "settings": {
    "delayModel": "delay",
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
          "id": "car",
          "type": "wiring.pin",
          "pos": [
            0,
            0
          ],
          "name": "car"
        },
        {
          "id": "register0",
          "type": "mem.register",
          "pos": [
            0,
            0
          ],
          "name": "s0",
          "attrs": {}
        },
        {
          "id": "register1",
          "type": "mem.register",
          "pos": [
            0,
            0
          ],
          "name": "s1",
          "attrs": {}
        },
        {
          "id": "ns_green",
          "type": "wiring.probe",
          "pos": [
            0,
            0
          ],
          "name": "ns_green"
        },
        {
          "id": "ew_green",
          "type": "wiring.probe",
          "pos": [
            0,
            0
          ],
          "name": "ew_green"
        },
        {
          "id": "xor0",
          "type": "gate.xor",
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
          "id": "not0",
          "type": "gate.not",
          "pos": [
            0,
            0
          ]
        },
        {
          "id": "not1",
          "type": "gate.not",
          "pos": [
            0,
            0
          ]
        },
        {
          "id": "and1",
          "type": "gate.and",
          "pos": [
            0,
            0
          ],
          "attrs": {
            "inputs": 3
          }
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
          "id": "not2",
          "type": "gate.not",
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
            "comp": "constant0",
            "pin": "out"
          },
          "b": {
            "comp": "register0",
            "pin": "en"
          }
        },
        {
          "a": {
            "comp": "constant1",
            "pin": "out"
          },
          "b": {
            "comp": "register0",
            "pin": "rst"
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
            "comp": "constant0",
            "pin": "out"
          },
          "b": {
            "comp": "register1",
            "pin": "en"
          }
        },
        {
          "a": {
            "comp": "constant1",
            "pin": "out"
          },
          "b": {
            "comp": "register1",
            "pin": "rst"
          }
        },
        {
          "a": {
            "comp": "register0",
            "pin": "q"
          },
          "b": {
            "comp": "xor0",
            "pin": "in0"
          }
        },
        {
          "a": {
            "comp": "car",
            "pin": "pin"
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
            "comp": "register0",
            "pin": "d"
          }
        },
        {
          "a": {
            "comp": "register0",
            "pin": "q"
          },
          "b": {
            "comp": "and0",
            "pin": "in0"
          }
        },
        {
          "a": {
            "comp": "car",
            "pin": "pin"
          },
          "b": {
            "comp": "and0",
            "pin": "in1"
          }
        },
        {
          "a": {
            "comp": "register0",
            "pin": "q"
          },
          "b": {
            "comp": "not0",
            "pin": "in"
          }
        },
        {
          "a": {
            "comp": "car",
            "pin": "pin"
          },
          "b": {
            "comp": "not1",
            "pin": "in"
          }
        },
        {
          "a": {
            "comp": "register1",
            "pin": "q"
          },
          "b": {
            "comp": "and1",
            "pin": "in0"
          }
        },
        {
          "a": {
            "comp": "not0",
            "pin": "out"
          },
          "b": {
            "comp": "and1",
            "pin": "in1"
          }
        },
        {
          "a": {
            "comp": "not1",
            "pin": "out"
          },
          "b": {
            "comp": "and1",
            "pin": "in2"
          }
        },
        {
          "a": {
            "comp": "and0",
            "pin": "out"
          },
          "b": {
            "comp": "or0",
            "pin": "in0"
          }
        },
        {
          "a": {
            "comp": "and1",
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
            "comp": "register1",
            "pin": "d"
          }
        },
        {
          "a": {
            "comp": "register1",
            "pin": "q"
          },
          "b": {
            "comp": "not2",
            "pin": "in"
          }
        },
        {
          "a": {
            "comp": "not2",
            "pin": "out"
          },
          "b": {
            "comp": "and2",
            "pin": "in0"
          }
        },
        {
          "a": {
            "comp": "register0",
            "pin": "q"
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
            "comp": "ns_green",
            "pin": "in"
          }
        },
        {
          "a": {
            "comp": "register1",
            "pin": "q"
          },
          "b": {
            "comp": "and3",
            "pin": "in0"
          }
        },
        {
          "a": {
            "comp": "not0",
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
            "comp": "ew_green",
            "pin": "in"
          }
        }
      ]
    }
  ]
}

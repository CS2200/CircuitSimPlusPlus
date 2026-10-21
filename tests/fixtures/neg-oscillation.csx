{
  "format": "circuitsim-plus-plus",
  "version": 5,
  "name": "neg-oscillation",
  "settings": {
    "clockHz": 1,
    "delayTable": "cs2200-74ls-v1"
  },
  "circuits": [
    {
      "name": "main",
      "components": [
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
          "id": "nand0",
          "type": "gate.nand",
          "pos": [
            0,
            0
          ]
        },
        {
          "id": "probe0",
          "type": "wiring.probe",
          "pos": [
            0,
            0
          ],
          "name": "p"
        }
      ],
      "wires": [
        {
          "a": {
            "comp": "constant0",
            "pin": "out"
          },
          "b": {
            "comp": "nand0",
            "pin": "in1"
          }
        },
        {
          "a": {
            "comp": "nand0",
            "pin": "out"
          },
          "b": {
            "comp": "nand0",
            "pin": "in0"
          }
        },
        {
          "a": {
            "comp": "nand0",
            "pin": "out"
          },
          "b": {
            "comp": "probe0",
            "pin": "in"
          }
        }
      ]
    }
  ]
}

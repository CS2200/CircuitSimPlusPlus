{
  "format": "circuitsim-plus-plus",
  "version": 4,
  "name": "neg-setup-violation",
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
          "id": "d",
          "type": "wiring.pin",
          "pos": [
            0,
            0
          ],
          "name": "d"
        },
        {
          "id": "register0",
          "type": "mem.register",
          "pos": [
            0,
            0
          ],
          "name": "r",
          "attrs": {}
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
            "comp": "d",
            "pin": "pin"
          },
          "b": {
            "comp": "register0",
            "pin": "d"
          }
        }
      ]
    }
  ]
}

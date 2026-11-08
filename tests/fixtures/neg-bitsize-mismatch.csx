{
  "format": "circuitsim-plus-plus",
  "version": 11,
  "name": "neg-bitsize-mismatch",
  "settings": {
    "clockHz": 1,
    "delayTable": "mips-r2000-2um-v1"
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
          "name": "a"
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
        }
      ],
      "wires": [
        {
          "a": {
            "comp": "a",
            "pin": "pin"
          },
          "b": {
            "comp": "b",
            "pin": "pin"
          }
        }
      ]
    }
  ]
}

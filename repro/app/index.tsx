import { Text, View } from 'react-native'

export default function Index() {
  return (
    <View
      style={{
        flex: 1,
        alignSelf: 'center',
        justifyContent: 'center',
        alignItems: 'center',
        minHeight: '100%',
      }}
    >
      <Text>Hello world, from One</Text>
      <Text>{process.env.VITE_REPRO_LABEL}</Text>
    </View>
  )
}

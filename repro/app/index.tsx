import { Text, View } from 'react-native'
import { first } from '../src/first'
import { second } from '../src/second'

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
      <Text>{first}</Text>
      <Text>{second}</Text>
    </View>
  )
}

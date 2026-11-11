import { One } from 'one'
import { Text, View } from 'react-native'

const date = Date.now() + 24 * 60 * 60 * 1000

One.Notifications.schedule({
  identifier: 'repro-date',
  content: { title: 'Repro' },
  trigger: { type: 'date', date },
}).then(
  (identifier) => console.log(`repro-scheduled ${identifier} at ${date}`),
  (error) => console.log(`repro-schedule-failed ${error}`)
)

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
      <Text>Scheduled a date notification for {new Date(date).toString()}</Text>
    </View>
  )
}

import { useState } from 'react'
import { RefreshControl, ScrollView, Text } from 'react-native'

export default function Index() {
  const [refreshing, setRefreshing] = useState(false)
  return (
    <ScrollView
      contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', alignItems: 'center' }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => setRefreshing(false)} />}
    >
      <Text>Pull to refresh</Text>
    </ScrollView>
  )
}
